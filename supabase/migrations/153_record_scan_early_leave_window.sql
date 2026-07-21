-- 153_record_scan_early_leave_window.sql
-- Kiosk-side follow-up to migration 151 (whose record_scan change was
-- withdrawn after it minted a duplicate overload).
--
-- This version is built from the LIVE record_scan definition (4 params,
-- including p_replay) pulled via pg_get_functiondef on 2026-07-21, so
-- CREATE OR REPLACE genuinely replaces it this time. ONE behavioural
-- change, everything else identical:
--
--   The no-standard_end clean-out window's lower edge moves from
--   8h05m to 7h30m after clock-in. PTL lets staff take their last
--   15-minute break by leaving early, so a scan around the 8h00m mark
--   is a normal end of day — it used to fall below the window, open
--   the off-site menu, and force a "Clock out early" tap. The upper
--   edge (8h25m, after which the menu deliberately appears so overtime
--   staff can record how they're leaving) is unchanged, as are the
--   standard_end path, the offline-replay path, and every guard.
--
-- Also drops the stray 3-arg overload from the original migration 151
-- in case it still exists, so this file is self-sufficient.
--
-- Safe to re-run.

drop function if exists public.record_scan(text, text, timestamptz);

CREATE OR REPLACE FUNCTION public.record_scan(p_qr_token text, p_device_token text, p_occurred_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_replay boolean DEFAULT false)
 RETURNS TABLE(action text, user_id bigint, name text, occurred_at timestamp with time zone, cooldown_seconds_remaining integer, breaks jsonb, current_status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_device_org     bigint;
    v_user           public.users%rowtype;
    v_last_clock     public.clock_events%rowtype;
    v_last_status    record;
    v_seconds_since  numeric;
    v_cooldown       integer := 60;
    v_occurred_at    timestamptz;
    v_now            timestamptz := now();
    v_too_old        boolean := false;
    v_tz             text;
    v_std_end_ts     timestamptz;
    v_breaks_json    jsonb;
    v_latest_user_ts timestamptz;
begin
    -- ---- device ----
    select d.organisation_id into v_device_org
      from public.device_registrations d
     where d.device_token = p_device_token;
    if not found then
        return query select 'device_unknown'::text, null::bigint, null::text,
                            null::timestamptz, null::integer, null::jsonb, null::text;
        return;
    end if;
    update public.device_registrations
       set last_seen = v_now where device_token = p_device_token;

    -- ---- occurred_at: H4 -> mark too-old explicitly instead of silently
    -- truncating to now-48h. Future timestamps still clamp to now (clock skew).
    v_occurred_at := coalesce(p_occurred_at, v_now);
    if v_occurred_at > v_now then v_occurred_at := v_now; end if;
    if v_occurred_at < v_now - interval '48 hours' then
        v_too_old := true;
    end if;

    -- ---- user: match on qr_token OR rfid_uid (both globally unique) -------
    select * into v_user
      from public.users u
     where u.qr_token = p_qr_token
        or u.rfid_uid = p_qr_token
     limit 1;
    if not found then
        return query select 'unknown'::text, null::bigint, null::text,
                            null::timestamptz, null::integer, null::jsonb, null::text;
        return;
    end if;
    if v_user.organisation_id <> v_device_org then
        return query select 'wrong_org'::text, v_user.id, v_user.name,
                            v_occurred_at, null::integer, null::jsonb, null::text;
        return;
    end if;
    if not v_user.active then
        return query select 'inactive'::text, v_user.id, v_user.name,
                            v_occurred_at, null::integer, null::jsonb, null::text;
        return;
    end if;

    -- H4: bail out NOW if too old, so the kiosk can drop / warn.
    if v_too_old then
        return query select 'too_old'::text, v_user.id, v_user.name,
                            p_occurred_at, null::integer, null::jsonb, null::text;
        return;
    end if;

    -- H3: refuse a replay that pre-dates a newer existing event for this
    -- user. Inserting it would corrupt the chronological order and break
    -- timesheet pairing.
    select greatest(
        coalesce((select max(ce.occurred_at) from public.clock_events ce
                    where ce.user_id = v_user.id), '-infinity'::timestamptz),
        coalesce((select max(se.occurred_at) from public.status_events se
                    where se.user_id = v_user.id), '-infinity'::timestamptz)
    ) into v_latest_user_ts;
    if v_latest_user_ts > '-infinity'::timestamptz
       and p_occurred_at is not null
       and v_occurred_at < v_latest_user_ts then
        return query select 'stale_replay'::text, v_user.id, v_user.name,
                            v_occurred_at, null::integer, null::jsonb, null::text;
        return;
    end if;

    -- ---- latest clock_event (for cooldown + state) ----
    select * into v_last_clock
      from public.clock_events ce
     where ce.user_id     = v_user.id
       and ce.occurred_at < v_occurred_at
     order by ce.occurred_at desc
     limit 1;

    if found then
        v_seconds_since := extract(epoch from (v_occurred_at - v_last_clock.occurred_at));
        if v_seconds_since < v_cooldown then
            return query select 'cooldown'::text, v_user.id, v_user.name,
                                v_last_clock.occurred_at,
                                greatest(1, (v_cooldown - v_seconds_since)::int),
                                null::jsonb, null::text;
            return;
        end if;
    end if;

    -- ---- live status since last clock-in ----
    select se.status, se.break_id, se.occurred_at
      into v_last_status
      from public.status_events se
     where se.user_id     = v_user.id
       and se.occurred_at < v_occurred_at
       and (v_last_clock.occurred_at is null
            or se.occurred_at >= v_last_clock.occurred_at)
     order by se.occurred_at desc
     limit 1;

    -- ------------------------------------------------------------ clock IN
    if v_last_clock.event_type is null or v_last_clock.event_type = 'out' then
        insert into public.clock_events
            (user_id, event_type, occurred_at, source, organisation_id)
        values
            (v_user.id, 'in', v_occurred_at, 'kiosk', v_device_org);
        insert into public.status_events
            (organisation_id, user_id, status, occurred_at, source)
        values
            (v_device_org, v_user.id, 'on_site', v_occurred_at, 'kiosk');
        return query select 'in'::text, v_user.id, v_user.name, v_occurred_at,
                            0, null::jsonb, 'on_site'::text;
        return;
    end if;

    -- ------------------------------------------------------- offsite return
    if v_last_status.status in ('off_site_break', 'off_site_job', 'off_site_personal') then
        insert into public.status_events
            (organisation_id, user_id, status, occurred_at, source)
        values
            (v_device_org, v_user.id, 'on_site', v_occurred_at, 'kiosk');
        return query select 'onsite_return'::text, v_user.id, v_user.name,
                            v_occurred_at, 0, null::jsonb, 'on_site'::text;
        return;
    end if;

    -- ----------------------------------------------------- shift-end clock-out
    -- On-site, mid-shift scan. A scan is a normal end-of-shift clock-out (menu
    -- suppressed) only when it lands in the expected end-of-shift WINDOW:
    -- from 7h30m to 8h25m after clock-in. The lower edge sits well under the
    -- nominal 8h15m because staff may take their last 15-minute break by
    -- leaving early (PTL policy) — a scan around 8h00m is a normal end of
    -- day, not a reason to open the menu. A scan BEFORE or AFTER that window
    -- opens the off-site menu, so overtime staff who scan well past 8h15m
    -- still get the menu (to record an off-site status, or to clock out via
    -- "Clock out") rather than being silently clocked out.
    --   * A per-employee fixed end time (standard_end) still wins when set:
    --     clock out inside [std_end - 20m, std_end + 12h]  (H5 bound).
    select coalesce(s.timezone, 'UTC') into v_tz
      from public.app_settings s where s.organisation_id = v_device_org;
    v_tz := coalesce(v_tz, 'UTC');

    if v_user.standard_end is not null then
        v_std_end_ts := ((v_occurred_at at time zone v_tz)::date || ' '
                         || v_user.standard_end::text)::timestamp at time zone v_tz;
        if v_occurred_at >= (v_std_end_ts - interval '20 minutes')
           and v_occurred_at <= (v_std_end_ts + interval '12 hours') then
            insert into public.clock_events
                (user_id, event_type, occurred_at, source, organisation_id)
            values
                (v_user.id, 'out', v_occurred_at, 'kiosk', v_device_org);
            return query select 'out'::text, v_user.id, v_user.name,
                                v_occurred_at, 0, null::jsonb, null::text;
            return;
        end if;
    elsif v_occurred_at >= v_last_clock.occurred_at + interval '7 hours 30 minutes'
      and v_occurred_at <= v_last_clock.occurred_at + interval '8 hours 25 minutes' then
        insert into public.clock_events
            (user_id, event_type, occurred_at, source, organisation_id)
        values
            (v_user.id, 'out', v_occurred_at, 'kiosk', v_device_org);
        return query select 'out'::text, v_user.id, v_user.name,
                            v_occurred_at, 0, null::jsonb, null::text;
        return;
    end if;

    -- ------------------------------------------------- offline replay: no
    -- menu possible. Nobody is at the tablet when the queue drains, so a
    -- scan that would have prompted the off-site menu is recorded as a
    -- clock-out at the scanned time instead of being dropped. Tagged
    -- 'offline-replay' so admins can spot (and correct) it in Clock entries.
    --
    -- Only for scans at/after 13:00 local time (org timezone): a morning
    -- menu-scan is far more likely a break or lunch departure than an
    -- end-of-day one, so assuming 'out' there would usually be wrong. A
    -- pre-1PM replay falls through to prompt_offsite, which records nothing;
    -- the kiosk counts it as "not recorded" for manual admin entry.
    if p_replay
       and extract(hour from (v_occurred_at at time zone v_tz)) >= 13 then
        insert into public.clock_events
            (user_id, event_type, occurred_at, source, organisation_id)
        values
            (v_user.id, 'out', v_occurred_at, 'offline-replay', v_device_org);
        return query select 'out'::text, v_user.id, v_user.name,
                            v_occurred_at, 0, null::jsonb, null::text;
        return;
    end if;

    -- ------------------------------------------------------- prompt offsite
    select jsonb_agg(
               jsonb_build_object(
                   'id',               b.id,
                   'name',             b.name,
                   'duration_minutes', b.duration_minutes,
                   'paid',             b.paid
               )
               order by b.trigger_hours_into_shift, b.id
           )
      into v_breaks_json
      from public.breaks b
     where b.organisation_id = v_device_org
       and b.active;

    return query select 'prompt_offsite'::text, v_user.id, v_user.name,
                        v_occurred_at, 0,
                        coalesce(v_breaks_json, '[]'::jsonb),
                        'on_site'::text;
end;
$function$;
