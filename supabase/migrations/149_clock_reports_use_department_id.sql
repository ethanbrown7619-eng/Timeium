-- 149_clock_reports_use_department_id.sql
-- The clock-side RPCs still read users.department — the legacy free-text
-- column from the original clock app — so anyone whose department was
-- assigned via the newer users.department_id FK (the column the whole
-- timesheet app manages) shows a blank Department in the Live view, the
-- Full report / Flag report / Clock vs Timesheet (weekly_timesheet and
-- timesheet_for_range both read _timesheet_rows), and the Off-site
-- events report. It can also show a STALE name for anyone who moved
-- departments after the text column was last written.
--
-- Fix: report coalesce(departments.name, users.department) — prefer the
-- live FK assignment, fall back to the legacy text for users who only
-- have the old value. Three functions recreated with only that change
-- (create or replace preserves existing grants):
--   - org_live_status
--   - _timesheet_rows
--   - _offsite_report
--
-- Safe to re-run.

create or replace function public.org_live_status(p_org_id bigint)
returns table(user_id bigint, name text, department text, status text, break_id bigint, break_name text, since timestamptz)
language sql stable security definer set search_path = public as $function$
    with last_clock as (
        select distinct on (ce.user_id) ce.user_id, ce.event_type, ce.occurred_at
          from public.clock_events ce
         where ce.organisation_id = p_org_id and ce.occurred_at > now() - interval '36 hours'
         order by ce.user_id, ce.occurred_at desc
    ),
    active_in as (
        select lc.user_id, lc.occurred_at as clocked_in_at from last_clock lc where lc.event_type = 'in'
    ),
    last_status as (
        select distinct on (se.user_id) se.user_id, se.status, se.break_id, se.occurred_at
          from public.status_events se
          join active_in ai on ai.user_id = se.user_id
         where se.organisation_id = p_org_id and se.occurred_at >= ai.clocked_in_at
         order by se.user_id, se.occurred_at desc
    )
    select u.id, u.name, coalesce(dept.name, u.department), coalesce(ls.status, 'on_site'), ls.break_id, b.name,
        coalesce(ls.occurred_at, ai.clocked_in_at)
      from active_in ai
      join public.users u on u.id = ai.user_id and u.active
      left join public.departments dept on dept.id = u.department_id
      left join last_status ls on ls.user_id = u.id
      left join public.breaks b on b.id = ls.break_id
     where u.organisation_id = p_org_id order by coalesce(dept.name, u.department) nulls last, u.name;
$function$;

create or replace function public._timesheet_rows(p_org_id bigint, p_start date, p_end_excl date, p_tz text)
returns table(user_id bigint, name text, department text, day date, first_in timestamptz, last_out timestamptz, raw_hours numeric, break_minutes integer, hours numeric, flag text)
language plpgsql stable security definer set search_path = public as $function$
declare
    v_ws timestamptz; v_we timestamptz; v_ws_buf timestamptz; v_we_buf timestamptz;
    v_tolerance integer; v_standard numeric; v_enable_std boolean;
begin
    select coalesce(s.clock_in_tolerance_minutes, 0), coalesce(s.auto_close_shift_hours, 8.5),
           coalesce(s.enable_standard_times, false)
      into v_tolerance, v_standard, v_enable_std
      from public.app_settings s where s.organisation_id = p_org_id;
    v_tolerance := coalesce(v_tolerance, 0);
    v_standard := coalesce(v_standard, 8.5);
    v_enable_std := coalesce(v_enable_std, false);
    v_ws := (p_start::timestamp) at time zone p_tz;
    v_we := (p_end_excl::timestamp) at time zone p_tz;
    v_ws_buf := v_ws - interval '1 day';
    v_we_buf := v_we + interval '1 day';
    return query
    with paired as (
        select u.id as uid, e.event_type as etype, e.occurred_at as occ, e.auto_closed as ac,
            lead(e.event_type) over w as next_type, lead(e.occurred_at) over w as next_at,
            lead(e.auto_closed) over w as next_ac,
            case when e.event_type = 'in' then
                row_number() over (partition by u.id, (e.occurred_at at time zone p_tz)::date, e.event_type
                    order by e.occurred_at) end as in_n_of_day
          from public.users u
          join public.clock_events e on e.user_id = u.id and e.occurred_at >= v_ws_buf and e.occurred_at < v_we_buf
         where u.organisation_id = p_org_id
         window w as (partition by u.id order by e.occurred_at)
    ),
    paired_eff as (
        select p.*,
            case when p.etype = 'in' and p.in_n_of_day = 1 and v_tolerance > 0
                  and extract(minute from (p.occ at time zone p_tz))::int <= v_tolerance
                then date_trunc('hour', p.occ at time zone p_tz) at time zone p_tz
                else p.occ end as occ_eff
          from paired p
    ),
    day_series as (
        select d::date as lday from generate_series(p_start, p_end_excl - 1, '1 day'::interval) d
    ),
    users_x_days as (
        select u.id, u.name, coalesce(dept.name, u.department) as department, u.standard_start, ds.lday
          from public.users u
          left join public.departments dept on dept.id = u.department_id
          cross join day_series ds
         where u.active and u.organisation_id = p_org_id
    ),
    events_per_day as (
        select p.uid, ((p.occ at time zone p_tz)::date) as lday,
            min(p.occ_eff) filter (where p.etype = 'in') as first_in_v,
            max(p.occ) filter (where p.etype = 'out') as last_out_v
          from paired_eff p
         where p.occ >= v_ws and p.occ < v_we
         group by p.uid, ((p.occ at time zone p_tz)::date)
    ),
    raw_per_day as (
        select e.uid, e.lday, e.first_in_v, e.last_out_v,
            case when e.first_in_v is not null and e.last_out_v is not null and e.last_out_v > e.first_in_v
                then round(extract(epoch from (e.last_out_v - e.first_in_v)) / 3600.0, 2)::numeric(10,2)
                else 0::numeric(10,2) end as raw
          from events_per_day e
    ),
    active_breaks as (
        select b.duration_minutes, b.trigger_hours_into_shift from public.breaks b
         where b.organisation_id = p_org_id and b.active
    ),
    breaks_per_day as (
        select r.uid, r.lday,
            coalesce((select sum(ab.duration_minutes) from active_breaks ab where r.raw >= ab.trigger_hours_into_shift), 0)::integer as break_min
          from raw_per_day r
    ),
    auto_close_per_day as (
        select p.uid, ((p.occ at time zone p_tz)::date) as lday, true as yellow
          from paired_eff p
         where p.etype = 'in' and p.next_type = 'out' and coalesce(p.next_ac, false)
           and p.occ >= v_ws and p.occ < v_we
         group by p.uid, ((p.occ at time zone p_tz)::date)
    ),
    late_per_day as (
        select ux.id as uid, ux.lday,
            case when not v_enable_std then false
                when ux.standard_start is null then false
                when r.first_in_v is null then false
                when r.first_in_v > ((ux.lday::timestamp + ux.standard_start) at time zone p_tz)
                    + make_interval(mins => v_tolerance) then true else false end as late_v
          from users_x_days ux left join raw_per_day r on r.uid = ux.id and r.lday = ux.lday
    ),
    final_per_day as (
        select r.uid, r.lday, r.first_in_v, r.last_out_v, r.raw,
            coalesce(bpd.break_min, 0) as break_min,
            greatest(r.raw - (coalesce(bpd.break_min, 0) / 60.0)::numeric(10,2), 0)::numeric(10,2) as final_hours
          from raw_per_day r left join breaks_per_day bpd on bpd.uid = r.uid and bpd.lday = r.lday
    )
    select ux.id, ux.name, ux.department, ux.lday, f.first_in_v, f.last_out_v,
        coalesce(f.raw, 0)::numeric(10,2), coalesce(f.break_min, 0), coalesce(f.final_hours, 0)::numeric(10,2),
        case when coalesce(f.final_hours, 0) > 0 and coalesce(f.final_hours, 0) < v_standard then 'red'
            when coalesce(acpd.yellow, false) then 'yellow'
            when coalesce(lpd.late_v, false) then 'orange' else null end
      from users_x_days ux
      left join final_per_day f on f.uid = ux.id and f.lday = ux.lday
      left join auto_close_per_day acpd on acpd.uid = ux.id and acpd.lday = ux.lday
      left join late_per_day lpd on lpd.uid = ux.id and lpd.lday = ux.lday
      order by ux.name, ux.lday;
end$function$;

create or replace function public._offsite_report(p_org_id bigint, p_start date, p_end_excl date, p_tz text)
returns table(user_id bigint, name text, department text, day date, reason text, status text, break_paid boolean, started_at timestamptz, returned_at timestamptz, return_kind text, actual_minutes numeric, expected_minutes numeric, tolerance_minutes integer, late_back boolean)
language plpgsql stable security definer set search_path = public as $function$
declare v_tolerance integer;
begin
    select coalesce(s.offsite_late_tolerance_minutes, 0) into v_tolerance
      from public.app_settings s where s.organisation_id = p_org_id;
    v_tolerance := coalesce(v_tolerance, 0);
    return query
    with offsite as (
        select se.id, se.user_id, se.status, se.break_id, se.occurred_at as started_at
          from public.status_events se
         where se.organisation_id = p_org_id
           and se.status in ('off_site_break','off_site_job','clocked_out_early')
           and (se.occurred_at at time zone p_tz)::date >= p_start
           and (se.occurred_at at time zone p_tz)::date < p_end_excl
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
