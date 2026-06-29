-- 126_leave_two_step_approval.sql
-- Phase A of leave management — foundation layer.
--
-- Adds a two-step approval workflow on public.leave_requests:
--   1. Employee submits → status='pending_manager'
--   2. Manager approves → status='pending_admin'
--   3. Admin approves   → status='approved' (triggers timesheet auto-pop)
-- Rejection at either step → 'rejected'; employee can cancel any
-- pre-approval state to 'cancelled'.
--
-- When the org runs in direct_to_admin mode (organisations.approval_workflow),
-- the manager step is skipped — the submit_leave_request RPC drops the
-- request straight into 'pending_admin'.
--
-- Schema deltas:
--   - new columns:  manager_reviewed_by, manager_reviewed_at, manager_review_note
--   - status enum:  pending → split into pending_manager / pending_admin
--   - existing 'pending' rows migrate to 'pending_manager' (the safer
--     default; any data sitting in 'pending' was from the shelved
--     prototype and won't have a manager_reviewed_* set yet anyway).
--
-- Seed: calls seed_default_leave_types for every existing org so the
-- six standard NZ leave types exist before the UI starts referencing
-- them. The seed function is idempotent (ON CONFLICT DO NOTHING).
--
-- New RPCs:
--   submit_leave_request           — employee creates a request
--   manager_approve_leave_request  — manager bumps pending_manager → pending_admin
--   manager_reject_leave_request   — manager bumps pending_manager → rejected
-- Existing approve_leave_request / reject_leave_request are updated to
-- gate on pending_admin (was: pending), so the admin step still owns
-- the timesheet auto-population side-effect.
--
-- Safe to re-run.

--------------------------------------------------------------------------------
-- columns + status enum
--------------------------------------------------------------------------------

alter table public.leave_requests
    add column if not exists manager_reviewed_by   bigint references public.users (id) on delete set null,
    add column if not exists manager_reviewed_at   timestamptz,
    add column if not exists manager_review_note   text;

-- Migrate any existing 'pending' rows before swapping the check constraint.
update public.leave_requests set status = 'pending_manager' where status = 'pending';

alter table public.leave_requests
    drop constraint if exists leave_requests_status_check;
alter table public.leave_requests
    add constraint leave_requests_status_check
        check (status in ('pending_manager','pending_admin','approved','rejected','cancelled'));

--------------------------------------------------------------------------------
-- seed default leave types for every org
--   seed_default_leave_types is from migration 041; idempotent.
--------------------------------------------------------------------------------

do $$
declare
    o record;
begin
    for o in select id from public.organisations loop
        perform public.seed_default_leave_types(o.id);
    end loop;
end$$;

--------------------------------------------------------------------------------
-- submit_leave_request — single entry point used by the employee form.
--   Routes to pending_admin or pending_manager based on the org's
--   approval_workflow setting.
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
    v_workflow   text;
    v_status     text;
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

    select coalesce(o.approval_workflow, 'manager_then_admin')
      into v_workflow
      from public.organisations o
     where o.id = v_org_id;

    v_status := case when v_workflow = 'direct_to_admin'
                     then 'pending_admin'
                     else 'pending_manager'
                end;

    insert into public.leave_requests (
        organisation_id, user_id, leave_type_id,
        start_date, end_date, hours_per_day, skip_weekends, reason, status
    )
    values (
        v_org_id, v_user_id, p_leave_type_id,
        p_start_date, p_end_date, p_hours_per_day, p_skip_weekends, p_reason, v_status
    )
    returning id into v_request_id;

    return v_request_id;
end$$;

grant execute on function public.submit_leave_request(bigint, date, date, numeric, boolean, text) to authenticated;

--------------------------------------------------------------------------------
-- manager_approve_leave_request — manager bumps to pending_admin.
--   Caller must manage the requesting employee, or be admin.
--------------------------------------------------------------------------------

create or replace function public.manager_approve_leave_request(
    p_request_id bigint,
    p_note text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    v_req         public.leave_requests;
    v_reviewer_id bigint;
begin
    select lr.* into v_req from public.leave_requests lr where lr.id = p_request_id;
    if v_req.id is null then
        raise exception 'Leave request not found';
    end if;
    if v_req.status <> 'pending_manager' then
        raise exception 'Only requests in pending_manager status can be manager-approved (current: %)', v_req.status;
    end if;
    if not (public.is_admin_of(v_req.organisation_id) or public.user_manages_target_user(v_req.user_id)) then
        raise exception 'Not authorised';
    end if;

    select u.id into v_reviewer_id
      from public.users u
     where u.auth_user_id = auth.uid()
       and u.organisation_id = v_req.organisation_id
     limit 1;

    update public.leave_requests
       set status               = 'pending_admin',
           manager_reviewed_by  = v_reviewer_id,
           manager_reviewed_at  = now(),
           manager_review_note  = p_note,
           updated_at           = now()
     where id = p_request_id;
end$$;

grant execute on function public.manager_approve_leave_request(bigint, text) to authenticated;

--------------------------------------------------------------------------------
-- manager_reject_leave_request — manager bumps to rejected, no admin step.
--------------------------------------------------------------------------------

create or replace function public.manager_reject_leave_request(
    p_request_id bigint,
    p_note text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    v_req         public.leave_requests;
    v_reviewer_id bigint;
begin
    select lr.* into v_req from public.leave_requests lr where lr.id = p_request_id;
    if v_req.id is null then
        raise exception 'Leave request not found';
    end if;
    if v_req.status <> 'pending_manager' then
        raise exception 'Only requests in pending_manager status can be manager-rejected (current: %)', v_req.status;
    end if;
    if not (public.is_admin_of(v_req.organisation_id) or public.user_manages_target_user(v_req.user_id)) then
        raise exception 'Not authorised';
    end if;

    select u.id into v_reviewer_id
      from public.users u
     where u.auth_user_id = auth.uid()
       and u.organisation_id = v_req.organisation_id
     limit 1;

    update public.leave_requests
       set status               = 'rejected',
           manager_reviewed_by  = v_reviewer_id,
           manager_reviewed_at  = now(),
           manager_review_note  = p_note,
           reviewed_by          = v_reviewer_id,
           reviewed_at          = now(),
           review_note          = p_note,
           updated_at           = now()
     where id = p_request_id;
end$$;

grant execute on function public.manager_reject_leave_request(bigint, text) to authenticated;

--------------------------------------------------------------------------------
-- approve_leave_request — UPDATED to require pending_admin (was: pending).
--   This is the FINAL admin approval. Triggers timesheet auto-population.
--   Reuses the body of migration 042's RPC for the timesheet population
--   logic — the only behavioural change is the status guard.
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
    if v_req.status <> 'pending_admin' then
        raise exception 'Only requests in pending_admin status can be admin-approved (current: %)', v_req.status;
    end if;

    select u.id into v_reviewer_id
      from public.users u
     where u.auth_user_id = auth.uid()
       and u.organisation_id = v_req.organisation_id
     limit 1;

    select j.id into v_job_id
      from public.jobs j
     where j.organisation_id = v_req.organisation_id
       and j.is_leave = true
       and j.leave_type_id = v_req.leave_type_id
     limit 1;
    if v_job_id is null then
        raise exception 'No leave job configured for this leave type. Ask an admin to create one in Configure > Jobs (tick "Leave job" and select the matching leave type).';
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

    update public.leave_requests
       set status = 'approved',
           reviewed_by = v_reviewer_id,
           reviewed_at = now(),
           review_note = p_note,
           applied_to_timesheet = true,
           applied_at = now(),
           updated_at = now()
     where id = p_request_id;
end$$;

grant execute on function public.approve_leave_request(bigint, text) to authenticated;

--------------------------------------------------------------------------------
-- reject_leave_request — UPDATED to gate on pending_admin or pending_manager.
--   Admin can reject at either stage (override path).
--------------------------------------------------------------------------------

create or replace function public.reject_leave_request(
    p_request_id bigint,
    p_note text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    v_req public.leave_requests;
    v_reviewer_id bigint;
begin
    select lr.* into v_req from public.leave_requests lr where lr.id = p_request_id;
    if v_req.id is null then
        raise exception 'Leave request not found';
    end if;
    if not public.is_admin_of(v_req.organisation_id) then
        raise exception 'Not authorised';
    end if;
    if v_req.status not in ('pending_admin', 'pending_manager') then
        raise exception 'Only requests still pending can be rejected (current: %)', v_req.status;
    end if;

    select u.id into v_reviewer_id
      from public.users u
     where u.auth_user_id = auth.uid()
       and u.organisation_id = v_req.organisation_id
     limit 1;

    update public.leave_requests
       set status = 'rejected',
           reviewed_by = v_reviewer_id,
           reviewed_at = now(),
           review_note = p_note,
           updated_at = now()
     where id = p_request_id;
end$$;

grant execute on function public.reject_leave_request(bigint, text) to authenticated;
