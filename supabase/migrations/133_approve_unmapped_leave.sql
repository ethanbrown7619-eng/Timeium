-- 133_approve_unmapped_leave.sql
-- Allow approval of a leave type that has no job mapping (e.g. Unpaid
-- Leave, which deliberately doesn't populate the timesheet). Previously
-- approve_leave_request raised "not mapped to a leave job" and blocked
-- the approval entirely.
--
-- New behaviour: if the leave type has a job_id, populate the timesheet
-- day-by-day as before. If it doesn't, skip population and just record
-- the approval — the leave is approved and tracked, it simply doesn't
-- land on a timesheet.
--
-- Safe to re-run.

create or replace function public.approve_leave_request(
    p_request_id bigint,
    p_note text default null
)
returns void
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_req public.leave_requests;
    v_reviewer_id bigint;
    v_job_id bigint;
    v_day date;
    v_week_start date;
    v_ts_id bigint;
    v_entry_id bigint;
    v_dow int;
    v_col text;
begin
    select lr.* into v_req from public.leave_requests lr where lr.id = p_request_id;
    if v_req.id is null then
        raise exception 'Leave request not found';
    end if;
    if not public.is_admin_of(v_req.organisation_id) then
        raise exception 'Not authorised to approve leave for this organisation';
    end if;
    if v_req.status not in ('pending_admin', 'pending_manager') then
        raise exception 'Only a pending request can be approved (current: %)', v_req.status;
    end if;

    select u.id into v_reviewer_id
      from public.users u
     where u.auth_user_id = auth.uid()
       and u.organisation_id = v_req.organisation_id
     limit 1;

    -- Resolve the leave job from the leave type's job_id link. May be
    -- null for types intentionally left unmapped (e.g. Unpaid Leave) —
    -- in that case we approve without touching the timesheet.
    select lt.job_id into v_job_id
      from public.leave_types lt
     where lt.id = v_req.leave_type_id;

    if v_job_id is not null then
        v_day := v_req.start_date;
        while v_day <= v_req.end_date loop
            v_dow := extract(isodow from v_day)::int;
            if v_req.skip_weekends and v_dow >= 6 then
                v_day := v_day + 1;
                continue;
            end if;
            v_week_start := v_day - (v_dow - 1);

            select id into v_ts_id
              from public.timesheets
             where user_id = v_req.user_id and week_start = v_week_start
             limit 1;
            if v_ts_id is null then
                insert into public.timesheets (organisation_id, user_id, week_start, status)
                  values (v_req.organisation_id, v_req.user_id, v_week_start, 'draft')
                  returning id into v_ts_id;
            end if;

            select id into v_entry_id
              from public.timesheet_entries
             where timesheet_id = v_ts_id and job_id = v_job_id
             limit 1;
            if v_entry_id is null then
                insert into public.timesheet_entries (timesheet_id, job_id, description)
                  values (v_ts_id, v_job_id,
                    case when v_req.reason is not null and trim(v_req.reason) <> ''
                         then v_req.reason else null end)
                  returning id into v_entry_id;
            end if;

            v_col := case v_dow
                when 1 then 'mon_hours' when 2 then 'tue_hours' when 3 then 'wed_hours'
                when 4 then 'thu_hours' when 5 then 'fri_hours'
                when 6 then 'sat_hours' when 7 then 'sun_hours'
            end;
            execute format('update public.timesheet_entries set %I = $1 where id = $2', v_col)
              using v_req.hours_per_day, v_entry_id;

            v_day := v_day + 1;
        end loop;
    end if;

    update public.leave_requests
       set status = 'approved',
           reviewed_by = v_reviewer_id,
           reviewed_at = now(),
           review_note = p_note,
           applied_to_timesheet = (v_job_id is not null),
           applied_at = now(),
           updated_at = now()
     where id = p_request_id;
end$$;

grant execute on function public.approve_leave_request(bigint, text) to authenticated;
