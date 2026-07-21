-- 150_manager_final_leave_approval.sql
-- Leave workflow changes:
--
-- 1. REMOVE THE ADMIN SIGN-OFF STEP. Manager approval is now final:
--    approving a request populates the employee's timesheet immediately.
--    The status flow becomes  pending_manager → approved | rejected.
--    Any request currently parked at pending_admin drops back into the
--    managers' queue so nothing is stranded.
--
-- 2. MANAGER REQUEST-ON-BEHALF. A manager (or admin) can raise leave for
--    an employee they manage. The request lands at the new status
--    'pending_employee' and the employee must accept it from My Requests
--    before it becomes approved (acceptance populates the timesheet,
--    with the requesting manager recorded as the reviewer). Declining
--    cancels it.
--
-- New/changed objects:
--   - column   leave_requests.requested_by (who raised an on-behalf request)
--   - status   'pending_employee' added to the check constraint
--   - fn       populate_timesheet_for_leave  (internal, shared population)
--   - fn       approve_leave_request         (manager OR admin, final)
--   - fn       manager_approve_leave_request (thin wrapper, kept for API compat)
--   - fn       submit_leave_request          (always → pending_manager)
--   - fn       submit_leave_request_on_behalf
--   - fn       accept_leave_request / decline_leave_request (employee)
--   - fn       list_managed_employees        (dropdown source)
--
-- Safe to re-run.

--------------------------------------------------------------------------------
-- schema: requested_by + status set
--------------------------------------------------------------------------------

alter table public.leave_requests
    add column if not exists requested_by bigint references public.users (id) on delete set null;

alter table public.leave_requests
    drop constraint if exists leave_requests_status_check;
alter table public.leave_requests
    add constraint leave_requests_status_check
        check (status in ('pending_employee','pending_manager','pending_admin','approved','rejected','cancelled'));

-- Requests stranded mid-pipeline go back to the managers' queue.
update public.leave_requests set status = 'pending_manager' where status = 'pending_admin';

--------------------------------------------------------------------------------
-- populate_timesheet_for_leave — internal shared helper.
--   The day-by-day timesheet population from migration 133, factored out
--   so both the manager-approval path and the employee-acceptance path
--   use the same logic. Not granted to clients — only callable from the
--   SECURITY DEFINER RPCs below.
--------------------------------------------------------------------------------

create or replace function public.populate_timesheet_for_leave(p_request_id bigint)
returns boolean  -- true when hours were written, false for unmapped types
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_req public.leave_requests;
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

    -- Leave types intentionally left unmapped (e.g. Unpaid Leave) are
    -- approved without touching the timesheet.
    select lt.job_id into v_job_id
      from public.leave_types lt
     where lt.id = v_req.leave_type_id;
    if v_job_id is null then
        return false;
    end if;

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

    return true;
end$$;

revoke execute on function public.populate_timesheet_for_leave(bigint) from public, anon, authenticated;

--------------------------------------------------------------------------------
-- approve_leave_request — FINAL approval, now open to managers.
--   Auth: admin of the org OR manager of the employee. Populates the
--   timesheet and marks the request approved in one step.
--------------------------------------------------------------------------------

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
    v_applied boolean;
begin
    select lr.* into v_req from public.leave_requests lr where lr.id = p_request_id;
    if v_req.id is null then
        raise exception 'Leave request not found';
    end if;
    if not (public.is_admin_of(v_req.organisation_id)
            or public.user_manages_target_user(v_req.user_id)) then
        raise exception 'Not authorised to approve leave for this employee';
    end if;
    if v_req.status not in ('pending_manager', 'pending_admin') then
        raise exception 'Only a pending request can be approved (current: %)', v_req.status;
    end if;

    select u.id into v_reviewer_id
      from public.users u
     where u.auth_user_id = auth.uid()
       and u.organisation_id = v_req.organisation_id
     limit 1;

    v_applied := public.populate_timesheet_for_leave(p_request_id);

    update public.leave_requests
       set status = 'approved',
           reviewed_by = v_reviewer_id,
           reviewed_at = now(),
           review_note = p_note,
           applied_to_timesheet = v_applied,
           applied_at = now(),
           updated_at = now()
     where id = p_request_id;
end$$;

grant execute on function public.approve_leave_request(bigint, text) to authenticated;

--------------------------------------------------------------------------------
-- manager_approve_leave_request — kept for API compatibility with the
--   Team Requests tab; now just performs the final approval.
--------------------------------------------------------------------------------

create or replace function public.manager_approve_leave_request(
    p_request_id bigint,
    p_note text default null
)
returns void
language plpgsql security definer set search_path = public, extensions
as $$
begin
    perform public.approve_leave_request(p_request_id, p_note);
end$$;

grant execute on function public.manager_approve_leave_request(bigint, text) to authenticated;

--------------------------------------------------------------------------------
-- submit_leave_request — employee self-service; single pending state.
--------------------------------------------------------------------------------

create or replace function public.submit_leave_request(
    p_leave_type_id  bigint,
    p_start_date     date,
    p_end_date       date,
    p_hours_per_day  numeric default 8.0,
    p_skip_weekends  boolean default true,
    p_reason         text default null
)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
    v_user_id    bigint;
    v_org_id     bigint;
    v_request_id bigint;
begin
    select id, organisation_id
      into v_user_id, v_org_id
      from public.users
     where auth_user_id = auth.uid()
     limit 1;
    if v_user_id is null then
        raise exception 'Not on the employee roster';
    end if;
    if p_leave_type_id is null then
        raise exception 'leave_type_id is required';
    end if;
    if p_start_date is null or p_end_date is null then
        raise exception 'start_date and end_date are required';
    end if;
    if p_end_date < p_start_date then
        raise exception 'end_date is before start_date';
    end if;
    if p_hours_per_day is null or p_hours_per_day <= 0 or p_hours_per_day > 24 then
        raise exception 'hours_per_day must be between 0 and 24';
    end if;

    insert into public.leave_requests (
        organisation_id, user_id, leave_type_id,
        start_date, end_date, hours_per_day, skip_weekends, reason, status
    )
    values (
        v_org_id, v_user_id, p_leave_type_id,
        p_start_date, p_end_date, p_hours_per_day, p_skip_weekends, p_reason, 'pending_manager'
    )
    returning id into v_request_id;

    return v_request_id;
end$$;

grant execute on function public.submit_leave_request(bigint, date, date, numeric, boolean, text) to authenticated;

--------------------------------------------------------------------------------
-- submit_leave_request_on_behalf — manager/admin raises leave for an
--   employee they manage. Lands at pending_employee; the employee must
--   accept it before it's approved.
--------------------------------------------------------------------------------

create or replace function public.submit_leave_request_on_behalf(
    p_user_id        bigint,
    p_leave_type_id  bigint,
    p_start_date     date,
    p_end_date       date,
    p_hours_per_day  numeric default 8.0,
    p_skip_weekends  boolean default true,
    p_reason         text default null
)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
    v_caller_id  bigint;
    v_org_id     bigint;
    v_target     public.users;
    v_request_id bigint;
begin
    select lr.* into v_target from public.users lr where lr.id = p_user_id;
    if v_target.id is null then
        raise exception 'Employee not found';
    end if;
    if not (public.is_admin_of(v_target.organisation_id)
            or public.user_manages_target_user(p_user_id)) then
        raise exception 'Not authorised to request leave for this employee';
    end if;

    select u.id, u.organisation_id into v_caller_id, v_org_id
      from public.users u
     where u.auth_user_id = auth.uid()
       and u.organisation_id = v_target.organisation_id
     limit 1;
    if v_caller_id is null then
        raise exception 'Not on the employee roster';
    end if;
    if v_caller_id = v_target.id then
        raise exception 'Use the normal Request Leave form for your own leave';
    end if;
    if p_leave_type_id is null then
        raise exception 'leave_type_id is required';
    end if;
    if p_start_date is null or p_end_date is null then
        raise exception 'start_date and end_date are required';
    end if;
    if p_end_date < p_start_date then
        raise exception 'end_date is before start_date';
    end if;
    if p_hours_per_day is null or p_hours_per_day <= 0 or p_hours_per_day > 24 then
        raise exception 'hours_per_day must be between 0 and 24';
    end if;

    insert into public.leave_requests (
        organisation_id, user_id, leave_type_id,
        start_date, end_date, hours_per_day, skip_weekends, reason,
        status, requested_by
    )
    values (
        v_target.organisation_id, v_target.id, p_leave_type_id,
        p_start_date, p_end_date, p_hours_per_day, p_skip_weekends, p_reason,
        'pending_employee', v_caller_id
    )
    returning id into v_request_id;

    return v_request_id;
end$$;

grant execute on function public.submit_leave_request_on_behalf(bigint, bigint, date, date, numeric, boolean, text) to authenticated;

--------------------------------------------------------------------------------
-- accept_leave_request — the employee accepts a manager-raised request.
--   Acceptance IS the approval: the requesting manager already signed it
--   off by raising it, so the timesheet populates immediately and the
--   manager is recorded as the reviewer.
--------------------------------------------------------------------------------

create or replace function public.accept_leave_request(p_request_id bigint)
returns void
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_req public.leave_requests;
    v_me  bigint;
    v_applied boolean;
begin
    select lr.* into v_req from public.leave_requests lr where lr.id = p_request_id;
    if v_req.id is null then
        raise exception 'Leave request not found';
    end if;

    select u.id into v_me
      from public.users u
     where u.auth_user_id = auth.uid()
       and u.organisation_id = v_req.organisation_id
     limit 1;
    if v_me is null or v_me <> v_req.user_id then
        raise exception 'Only the employee this request is for can accept it';
    end if;
    if v_req.status <> 'pending_employee' then
        raise exception 'Only requests awaiting your acceptance can be accepted (current: %)', v_req.status;
    end if;

    v_applied := public.populate_timesheet_for_leave(p_request_id);

    update public.leave_requests
       set status = 'approved',
           reviewed_by = coalesce(v_req.requested_by, v_me),
           reviewed_at = now(),
           applied_to_timesheet = v_applied,
           applied_at = now(),
           updated_at = now()
     where id = p_request_id;
end$$;

grant execute on function public.accept_leave_request(bigint) to authenticated;

--------------------------------------------------------------------------------
-- decline_leave_request — the employee declines a manager-raised request.
--------------------------------------------------------------------------------

create or replace function public.decline_leave_request(
    p_request_id bigint,
    p_note text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    v_req public.leave_requests;
    v_me  bigint;
begin
    select lr.* into v_req from public.leave_requests lr where lr.id = p_request_id;
    if v_req.id is null then
        raise exception 'Leave request not found';
    end if;

    select u.id into v_me
      from public.users u
     where u.auth_user_id = auth.uid()
       and u.organisation_id = v_req.organisation_id
     limit 1;
    if v_me is null or v_me <> v_req.user_id then
        raise exception 'Only the employee this request is for can decline it';
    end if;
    if v_req.status <> 'pending_employee' then
        raise exception 'Only requests awaiting your acceptance can be declined (current: %)', v_req.status;
    end if;

    update public.leave_requests
       set status = 'cancelled',
           review_note = coalesce(p_note, 'Declined by employee'),
           updated_at = now()
     where id = p_request_id;
end$$;

grant execute on function public.decline_leave_request(bigint, text) to authenticated;

--------------------------------------------------------------------------------
-- list_managed_employees — dropdown source for request-on-behalf.
--   Managers get the active staff in departments they manage; admins get
--   everyone. The caller themselves is excluded.
--------------------------------------------------------------------------------

create or replace function public.list_managed_employees(p_org_id bigint)
returns table (id bigint, name text)
language sql stable security definer set search_path = public
as $$
    select u.id, u.name
      from public.users u
      left join public.departments d on d.id = u.department_id
     where u.organisation_id = p_org_id
       and u.active
       and u.auth_user_id is distinct from auth.uid()
       and (
            public.is_admin_of(p_org_id)
            or exists (
                select 1 from public.users mgr
                 where mgr.id = d.manager_id
                   and mgr.auth_user_id = auth.uid()
            )
       )
     order by u.name;
$$;

grant execute on function public.list_managed_employees(bigint) to authenticated;
