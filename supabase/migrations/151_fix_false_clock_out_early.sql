-- 151_fix_false_clock_out_early.sql
-- The Off-site events report is spammed with "Clock out early" rows that
-- aren't real early departures.
--
-- Root cause: record_scan only treats an out-scan as a clean clock-out
-- when the employee has a standard_end set AND scans within 20 minutes
-- of it. Anyone with no standard_end — or anyone leaving a little
-- earlier after a full day (e.g. the take-your-last-break-at-home
-- policy) — gets the off-site prompt instead, taps "Clock out early"
-- to leave, and lands in the report.
--
-- Fix, both ends:
--
-- 1. record_scan: add a FULL-SHIFT FALLBACK. If the scan doesn't hit
--    the standard_end window but the employee has already been clocked
--    in for a full shift's worth of hours (auto_close_shift_hours − 1,
--    so 7.5h on the default 8.5), it's a clean clock-out — no prompt,
--    no status event. Genuinely early departures (more than ~an hour
--    short of a full day, before the standard_end window) still prompt.
--
-- 2. _offsite_report: suppress historic + future "Clock out early" rows
--    that weren't actually early — the event is within 20 minutes of
--    the employee's standard_end, or the shift had already run a full
--    shift's worth of hours. This also cleans up the weeks already
--    spammed, since the report derives from raw events every time.
--
-- NOTE: record_scan is originally owned by the kiosk (Attendium) side
-- of the shared database — if a kiosk-side migration recreates it
-- later, re-run this file to restore the fallback.
--
-- Safe to re-run.

--------------------------------------------------------------------------------
-- record_scan — kiosk QR/RFID scan with full-shift fallback on the out path
--------------------------------------------------------------------------------

create or replace function public.record_scan(p_qr_token text, p_device_token text, p_occurred_at timestamptz default null)
returns table(action text, user_id bigint, name text, occurred_at timestamptz, cooldown_seconds_remaining integer, breaks jsonb, current_status text)
language plpgsql security definer set search_path = public as $function$
declare
    v_device_org bigint; v_user public.users%rowtype; v_last_clock public.clock_events%rowtype;
    v_last_status record; v_seconds_since numeric; v_cooldown integer := 60;
    v_occurred_at timestamptz; v_now timestamptz := now(); v_too_old boolean := false;
    v_tz text; v_std_end_ts timestamptz; v_breaks_json jsonb; v_latest_user_ts timestamptz;
    v_full_shift numeric;
begin
    select d.organisation_id into v_device_org from public.device_registrations d where d.device_token = p_device_token;
    if not found then
        return query select 'device_unknown'::text, null::bigint, null::text, null::timestamptz, null::integer, null::jsonb, null::text;
        return;
    end if;
    update public.device_registrations set last_seen = v_now where device_token = p_device_token;
    v_occurred_at := coalesce(p_occurred_at, v_now);
    if v_occurred_at > v_now then v_occurred_at := v_now; end if;
    if v_occurred_at < v_now - interval '48 hours' then v_too_old := true; end if;
    select * into v_user from public.users u where u.qr_token = p_qr_token or u.rfid_uid = p_qr_token limit 1;
    if not found then
        return query select 'unknown'::text, null::bigint, null::text, null::timestamptz, null::integer, null::jsonb, null::text;
        return;
    end if;
    if v_user.organisation_id <> v_device_org then
        return query select 'wrong_org'::text, v_user.id, v_user.name, v_occurred_at, null::integer, null::jsonb, null::text;
        return;
    end if;
    if not v_user.active then
        return query select 'inactive'::text, v_user.id, v_user.name, v_occurred_at, null::integer, null::jsonb, null::text;
        return;
    end if;
    if v_too_old then
        return query select 'too_old'::text, v_user.id, v_user.name, p_occurred_at, null::integer, null::jsonb, null::text;
        return;
    end if;
    select greatest(
        coalesce((select max(ce.occurred_at) from public.clock_events ce where ce.user_id = v_user.id), '-infinity'::timestamptz),
        coalesce((select max(se.occurred_at) from public.status_events se where se.user_id = v_user.id), '-infinity'::timestamptz)
    ) into v_latest_user_ts;
    if v_latest_user_ts > '-infinity'::timestamptz and p_occurred_at is not null and v_occurred_at < v_latest_user_ts then
        return query select 'stale_replay'::text, v_user.id, v_user.name, v_occurred_at, null::integer, null::jsonb, null::text;
        return;
    end if;
    select * into v_last_clock from public.clock_events ce
        where ce.user_id = v_user.id and ce.occurred_at < v_occurred_at order by ce.occurred_at desc limit 1;
    if found then
        v_seconds_since := extract(epoch from (v_occurred_at - v_last_clock.occurred_at));
        if v_seconds_since < v_cooldown then
            return query select 'cooldown'::text, v_user.id, v_user.name, v_last_clock.occurred_at,
                greatest(1, (v_cooldown - v_seconds_since)::int), null::jsonb, null::text;
            return;
        end if;
    end if;
    select se.status, se.break_id, se.occurred_at into v_last_status
      from public.status_events se
     where se.user_id = v_user.id and se.occurred_at < v_occurred_at
       and (v_last_clock.occurred_at is null or se.occurred_at >= v_last_clock.occurred_at)
     order by se.occurred_at desc limit 1;
    if v_last_clock.event_type is null or v_last_clock.event_type = 'out' then
        insert into public.clock_events (user_id, event_type, occurred_at, source, organisation_id)
            values (v_user.id, 'in', v_occurred_at, 'kiosk', v_device_org);
        insert into public.status_events (organisation_id, user_id, status, occurred_at, source)
            values (v_device_org, v_user.id, 'on_site', v_occurred_at, 'kiosk');
        return query select 'in'::text, v_user.id, v_user.name, v_occurred_at, 0, null::jsonb, 'on_site'::text;
        return;
    end if;
    if v_last_status.status in ('off_site_break', 'off_site_job') then
        insert into public.status_events (organisation_id, user_id, status, occurred_at, source)
            values (v_device_org, v_user.id, 'on_site', v_occurred_at, 'kiosk');
        return query select 'onsite_return'::text, v_user.id, v_user.name, v_occurred_at, 0, null::jsonb, 'on_site'::text;
        return;
    end if;
    select coalesce(s.timezone, 'UTC'), coalesce(s.auto_close_shift_hours, 8.5)
      into v_tz, v_full_shift
      from public.app_settings s where s.organisation_id = v_device_org;
    v_tz := coalesce(v_tz, 'UTC');
    -- "Full shift" = an hour under the auto-close length (7.5h on the
    -- 8.5 default), floored at 4h for very short auto-close configs.
    v_full_shift := greatest(coalesce(v_full_shift, 8.5) - 1.0, 4.0);
    if v_user.standard_end is not null then
        v_std_end_ts := ((v_occurred_at at time zone v_tz)::date || ' ' || v_user.standard_end::text)::timestamp at time zone v_tz;
        if v_occurred_at >= (v_std_end_ts - interval '20 minutes') and v_occurred_at <= (v_std_end_ts + interval '12 hours') then
            insert into public.clock_events (user_id, event_type, occurred_at, source, organisation_id)
                values (v_user.id, 'out', v_occurred_at, 'kiosk', v_device_org);
            return query select 'out'::text, v_user.id, v_user.name, v_occurred_at, 0, null::jsonb, null::text;
            return;
        end if;
    end if;
    -- Full-shift fallback: they've been clocked in long enough that this
    -- is just the end of their day — record a clean out instead of the
    -- off-site prompt. Covers staff with no standard_end configured and
    -- anyone leaving slightly early after a full day.
    if v_last_clock.event_type = 'in'
       and extract(epoch from (v_occurred_at - v_last_clock.occurred_at)) / 3600.0 >= v_full_shift then
        insert into public.clock_events (user_id, event_type, occurred_at, source, organisation_id)
            values (v_user.id, 'out', v_occurred_at, 'kiosk', v_device_org);
        return query select 'out'::text, v_user.id, v_user.name, v_occurred_at, 0, null::jsonb, null::text;
        return;
    end if;
    select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name,
        'duration_minutes', b.duration_minutes, 'paid', b.paid)
        order by b.trigger_hours_into_shift, b.id) into v_breaks_json
      from public.breaks b where b.organisation_id = v_device_org and b.active;
    return query select 'prompt_offsite'::text, v_user.id, v_user.name, v_occurred_at, 0,
        coalesce(v_breaks_json, '[]'::jsonb), 'on_site'::text;
end$function$;

--------------------------------------------------------------------------------
-- _offsite_report — suppress "Clock out early" rows that weren't early.
--   Built on the migration-149 version (department_id coalesce kept).
--------------------------------------------------------------------------------

create or replace function public._offsite_report(p_org_id bigint, p_start date, p_end_excl date, p_tz text)
returns table(user_id bigint, name text, department text, day date, reason text, status text, break_paid boolean, started_at timestamptz, returned_at timestamptz, return_kind text, actual_minutes numeric, expected_minutes numeric, tolerance_minutes integer, late_back boolean)
language plpgsql stable security definer set search_path = public as $function$
declare v_tolerance integer; v_full_shift numeric;
begin
    select coalesce(s.offsite_late_tolerance_minutes, 0), coalesce(s.auto_close_shift_hours, 8.5)
      into v_tolerance, v_full_shift
      from public.app_settings s where s.organisation_id = p_org_id;
    v_tolerance := coalesce(v_tolerance, 0);
    v_full_shift := greatest(coalesce(v_full_shift, 8.5) - 1.0, 4.0);
    return query
    with offsite as (
        select se.id, se.user_id, se.status, se.break_id, se.occurred_at as started_at
          from public.status_events se
          join public.users su on su.id = se.user_id
         where se.organisation_id = p_org_id
           and se.status in ('off_site_break','off_site_job','clocked_out_early')
           and (se.occurred_at at time zone p_tz)::date >= p_start
           and (se.occurred_at at time zone p_tz)::date < p_end_excl
           -- Only report a "Clock out early" that was genuinely early:
           -- not within 20 min of the employee's standard end, and not
           -- after a full shift's worth of clocked-in hours.
           and not (
               se.status = 'clocked_out_early'
               and (
                    (su.standard_end is not null
                     and se.occurred_at >= ((((se.occurred_at at time zone p_tz)::date)::text || ' ' || su.standard_end::text)::timestamp at time zone p_tz) - interval '20 minutes')
                 or coalesce((
                      select extract(epoch from (se.occurred_at - ci.occurred_at)) / 3600.0
                        from public.clock_events ci
                       where ci.user_id = se.user_id
                         and ci.organisation_id = p_org_id
                         and ci.event_type = 'in'
                         and ci.occurred_at < se.occurred_at
                       order by ci.occurred_at desc limit 1
                    ) >= v_full_shift, false)
               )
           )
    ),
    paired as (
        select o.*, next_on.occurred_at as next_onsite_at,
            next_out.occurred_at as next_out_at, next_out.auto_closed as next_out_auto
          from offsite o
          left join lateral (select se2.occurred_at from public.status_events se2
            where se2.user_id = o.user_id and se2.organisation_id = p_org_id
              and se2.status = 'on_site' and se2.occurred_at > o.started_at
            order by se2.occurred_at asc limit 1) next_on on true
          left join lateral (select ce.occurred_at, ce.auto_closed from public.clock_events ce
            where ce.user_id = o.user_id and ce.organisation_id = p_org_id
              and ce.event_type = 'out' and ce.occurred_at > o.started_at
            order by ce.occurred_at asc limit 1) next_out on true
    )
    select u.id, u.name, coalesce(dept.name, u.department), (p.started_at at time zone p_tz)::date,
        case p.status when 'off_site_break' then coalesce(b.name, 'Break')
            when 'off_site_job' then 'Off-site job'
            when 'clocked_out_early' then 'Clock out early' else p.status end,
        p.status, b.paid, p.started_at,
        case when p.status = 'clocked_out_early' then null
            when p.next_onsite_at is not null and (p.next_out_at is null or p.next_onsite_at <= p.next_out_at) then p.next_onsite_at
            when p.next_out_at is not null and (p.next_onsite_at is null or p.next_out_at < p.next_onsite_at) then p.next_out_at
            else null end,
        case when p.status = 'clocked_out_early' then null
            when p.next_onsite_at is not null and (p.next_out_at is null or p.next_onsite_at <= p.next_out_at) then 'scan'
            when p.next_out_at is not null and (p.next_onsite_at is null or p.next_out_at < p.next_onsite_at)
                then case when p.next_out_auto then 'auto_close' else 'clock_out' end
            else null end,
        case when p.status = 'clocked_out_early' then null
            when p.next_onsite_at is not null and (p.next_out_at is null or p.next_onsite_at <= p.next_out_at)
                then round(extract(epoch from (p.next_onsite_at - p.started_at)) / 60.0, 1)
            when p.next_out_at is not null and (p.next_onsite_at is null or p.next_out_at < p.next_onsite_at)
                then round(extract(epoch from (p.next_out_at - p.started_at)) / 60.0, 1)
            else null end,
        b.duration_minutes::numeric, v_tolerance,
        case when p.status = 'off_site_break' and b.duration_minutes is not null
              and ((p.next_onsite_at is not null and (p.next_out_at is null or p.next_onsite_at <= p.next_out_at)
                    and extract(epoch from (p.next_onsite_at - p.started_at)) / 60.0 > (b.duration_minutes + v_tolerance))
                or (p.next_out_at is not null and (p.next_onsite_at is null or p.next_out_at < p.next_onsite_at)
                    and extract(epoch from (p.next_out_at - p.started_at)) / 60.0 > (b.duration_minutes + v_tolerance)))
            then true else false end
      from paired p
      join public.users u on u.id = p.user_id
      left join public.departments dept on dept.id = u.department_id
      left join public.breaks b on b.id = p.break_id
     order by p.started_at;
end$function$;
