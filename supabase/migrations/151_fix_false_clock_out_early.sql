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
-- Fix (report side): _offsite_report suppresses historic + future
-- "Clock out early" rows that weren't actually early — the event is
-- within 20 minutes of the employee's standard_end, or the shift had
-- already run a full shift's worth of hours. This also cleans up the
-- weeks already spammed, since the report derives from raw events
-- every time.
--
-- The kiosk-side record_scan change originally in this migration is
-- WITHDRAWN — see the section note below. The live kiosk function has
-- an extra p_replay parameter, so the CREATE here minted a duplicate
-- overload and broke every scan with "could not choose best candidate
-- function". This file now drops that stray overload instead.
--
-- Safe to re-run.

--------------------------------------------------------------------------------
-- record_scan — REMOVED (2026-07-21).
--   The live kiosk function's parameter list differs from the copy this
--   migration was based on, so the CREATE here added a SECOND overload
--   instead of replacing it — every kiosk scan then failed with "could
--   not choose best candidate function". The drop below removes that
--   stray overload and leaves the kiosk's original function untouched.
--   The full-shift fallback will be re-applied against the real live
--   definition in a later migration.
--------------------------------------------------------------------------------

drop function if exists public.record_scan(text, text, timestamptz);

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
