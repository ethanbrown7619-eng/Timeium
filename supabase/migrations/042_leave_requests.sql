-- 042_leave_requests.sql
-- Leave request workflow: employee requests leave, manager/admin approves,
-- approved requests auto-populate the employee's timesheet.
--
-- Safe to re-run.

--------------------------------------------------------------------------------
-- leave_requests
--------------------------------------------------------------------------------

create table if not exists public.leave_requests (
    id              bigserial primary key,
    organisation_id bigint not null references public.organisations (id) on delete cascade,
    user_id         bigint not null references public.users (id) on delete cascade,
    leave_type_id   bigint not null references public.leave_types (id) on delete restrict,
    start_date      date   not null,
    end_date        date   not null,
    hours_per_day   numeric(4,2) not null default 8.0,
    skip_weekends   boolean not null default true,
    reason          text,
    status          text   not null default 'pending'
        check (status in ('pending', 'approved', 'rejected', 'cancelled')),
    reviewed_by     bigint references public.users (id) on delete set null,
    reviewed_at     timestamptz,
    review_note     text,
    applied_to_timesheet boolean not null default false,
    applied_at      timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    check (end_date >= start_date)
);

create index if not exists leave_requests_user_idx on public.leave_requests (user_id, status);
create index if not exists leave_requests_org_status_idx on public.leave_requests (organisation_id, status);
create index if not exists leave_requests_dates_idx on public.leave_requests (start_date, end_date);

alter table public.leave_requests enable row level security;

-- Employees see and create their own requests
drop policy if exists "employees own leave_requests" on public.leave_requests;
create policy "employees own leave_requests"
    on public.leave_requests for all
    using (
        exists (
            select 1 from public.users u
            where u.id = leave_requests.user_id
              and u.auth_user_id = auth.uid()
        )
    )
    with check (
        exists (
            select 1 from public.users u
            where u.id = leave_requests.user_id
              and u.auth_user_id = auth.uid()
        )
    );

-- Managers/admins see all requests for their org
drop policy if exists "managers read leave_requests" on public.leave_requests;
create policy "managers read leave_requests"
    on public.leave_requests for select
    using (public.is_manager_of(organisation_id));

-- Managers/admins can update requests (to approve/reject)
drop policy if exists "managers update leave_requests" on public.leave_requests;
create policy "managers update leave_requests"
    on public.leave_requests for update
    using (public.is_manager_of(organisation_id))
    with check (public.is_manager_of(organisation_id));

--------------------------------------------------------------------------------
-- approve_leave_request(p_request_id, p_note)
--
-- Approves a pending leave request and auto-populates the employee's
-- timesheet for each day in the range. Skips weekends when skip_weekends=true.
-- Requires a job with is_leave=true and leave_type_id matching the request
-- to exist in the organisation.
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
    -- Must be a manager or admin of the org
    select lr.* into v_req
      from public.leave_requests lr
      where lr.id = p_request_id;

    if v_req.id is null then
        raise exception 'Leave request not found';
    end if;

    if not public.is_manager_of(v_req.organisation_id) then
        raise exception 'Not authorised to approve leave for this organisation';
    end if;

    if v_req.status <> 'pending' then
        raise exception 'Only pending requests can be approved';
    end if;

    -- Find the reviewer's users row
    select u.id into v_reviewer_id
      from public.users u
      where u.auth_user_id = auth.uid()
        and u.organisation_id = v_req.organisation_id
      limit 1;

    -- Find a leave job matching the leave type
    select j.id into v_job_id
      from public.jobs j
      where j.organisation_id = v_req.organisation_id
        and j.is_leave = true
        and j.leave_type_id = v_req.leave_type_id
      limit 1;

    if v_job_id is null then
        raise exception 'No leave job configured for this leave type. Ask an admin to create one in Configure > Jobs (tick "Leave job" and select the matching leave type).';
    end if;

    -- Populate timesheet day-by-day
    v_day := v_req.start_date;
    while v_day <= v_req.end_date loop
        v_dow := extract(isodow from v_day)::int;  -- 1=Mon .. 7=Sun

        -- Skip weekends if requested
        if v_req.skip_weekends and v_dow >= 6 then
            v_day := v_day + 1;
            continue;
        end if;

        -- Compute Monday of this week
        v_week_start := v_day - (v_dow - 1);

        -- Get or create the timesheet for this employee+week
        select id into v_ts_id
          from public.timesheets
          where user_id = v_req.user_id
            and week_start = v_week_start
          limit 1;

        if v_ts_id is null then
            insert into public.timesheets (organisation_id, user_id, week_start, status)
              values (v_req.organisation_id, v_req.user_id, v_week_start, 'draft')
              returning id into v_ts_id;
        end if;

        -- Get or create an entry for this leave job in this timesheet
        select id into v_entry_id
          from public.timesheet_entries
          where timesheet_id = v_ts_id
            and job_id = v_job_id
          limit 1;

        if v_entry_id is null then
            insert into public.timesheet_entries (timesheet_id, job_id, description)
              values (v_ts_id, v_job_id,
                case when v_req.reason is not null and trim(v_req.reason) <> ''
                     then v_req.reason else null end)
              returning id into v_entry_id;
        end if;

        -- Set the appropriate day's hours
        v_col := case v_dow
            when 1 then 'mon_hours'
            when 2 then 'tue_hours'
            when 3 then 'wed_hours'
            when 4 then 'thu_hours'
            when 5 then 'fri_hours'
            when 6 then 'sat_hours'
            when 7 then 'sun_hours'
        end;

        execute format('update public.timesheet_entries set %I = $1 where id = $2', v_col)
          using v_req.hours_per_day, v_entry_id;

        v_day := v_day + 1;
    end loop;

    -- Mark the request approved
    update public.leave_requests
      set status = 'approved',
          reviewed_by = v_reviewer_id,
          reviewed_at = now(),
          review_note = p_note,
          applied_to_timesheet = true,
          applied_at = now(),
          updated_at = now()
      where id = p_request_id;
end;
$$;

grant execute on function public.approve_leave_request(bigint, text) to authenticated;

--------------------------------------------------------------------------------
-- reject_leave_request(p_request_id, p_note)
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
    if not public.is_manager_of(v_req.organisation_id) then
        raise exception 'Not authorised';
    end if;
    if v_req.status <> 'pending' then
        raise exception 'Only pending requests can be rejected';
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
end;
$$;

grant execute on function public.reject_leave_request(bigint, text) to authenticated;
