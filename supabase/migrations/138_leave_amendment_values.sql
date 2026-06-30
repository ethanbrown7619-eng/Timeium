-- 138_leave_amendment_values.sql
-- Turn "request amendment" into a structured proposal: the employee
-- submits the new leave values they want (type/dates/hours), an admin
-- reviews and applies them in one click. Replaces the free-text-only
-- amendment from migration 136.
--
-- Proposed values live on the same row (proposed_* columns) alongside
-- the existing change_request_type='amend' flag.
--
-- RPCs:
--   request_leave_amendment(...) — employee proposes new values on own
--     approved leave.
--   apply_leave_amendment(req)   — admin: strip the old leave hours off
--     the timesheet, copy the proposed values into the live fields,
--     re-populate the timesheet, clear the proposal. Status stays
--     'approved'.
--
-- Safe to re-run.

alter table public.leave_requests
    add column if not exists proposed_leave_type_id bigint references public.leave_types (id) on delete set null,
    add column if not exists proposed_start_date    date,
    add column if not exists proposed_end_date      date,
    add column if not exists proposed_hours_per_day  numeric(4,2),
    add column if not exists proposed_skip_weekends  boolean,
    add column if not exists proposed_reason         text;

--------------------------------------------------------------------------------
-- request_leave_amendment — employee proposes new values for own approved leave.
--------------------------------------------------------------------------------

create or replace function public.request_leave_amendment(
    p_request_id     bigint,
    p_leave_type_id  bigint,
    p_start_date     date,
    p_end_date       date,
    p_hours_per_day  numeric,
    p_skip_weekends  boolean,
    p_reason         text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    v_req     public.leave_requests;
    v_user_id bigint;
begin
    select lr.* into v_req from public.leave_requests lr where lr.id = p_request_id;
    if v_req.id is null then
        raise exception 'Leave request not found';
    end if;
    if v_req.status <> 'approved' then
        raise exception 'Only approved leave can be amended (current: %)', v_req.status;
    end if;
    select u.id into v_user_id from public.users u where u.auth_user_id = auth.uid() limit 1;
    if v_user_id is null or v_user_id <> v_req.user_id then
        raise exception 'Not authorised — you can only amend your own leave';
    end if;
    if p_end_date < p_start_date then
        raise exception 'end date is before start date';
    end if;
    if p_hours_per_day is null or p_hours_per_day <= 0 or p_hours_per_day > 24 then
        raise exception 'hours_per_day must be between 0 and 24';
    end if;

    update public.leave_requests
       set change_request_type    = 'amend',
           change_request_note     = null,
           change_requested_at     = now(),
           proposed_leave_type_id  = p_leave_type_id,
           proposed_start_date     = p_start_date,
           proposed_end_date       = p_end_date,
           proposed_hours_per_day  = p_hours_per_day,
           proposed_skip_weekends  = coalesce(p_skip_weekends, true),
           proposed_reason         = p_reason,
           updated_at = now()
     where id = p_request_id;
end$$;

grant execute on function public.request_leave_amendment(bigint, bigint, date, date, numeric, boolean, text) to authenticated;

--------------------------------------------------------------------------------
-- apply_leave_amendment — admin applies the proposed values.
--   1. Remove the currently-approved leave hours from the timesheet.
--   2. Overwrite the live fields with the proposed values.
--   3. Re-populate the timesheet from the new values.
--   4. Clear the change request + proposed columns. Status stays approved.
--------------------------------------------------------------------------------

create or replace function public.apply_leave_amendment(p_request_id bigint)
returns void
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_req public.leave_requests;
    v_old_job bigint;
    v_new_job bigint;
    v_day date; v_week_start date; v_ts_id bigint; v_entry_id bigint;
    v_dow int; v_col text;
begin
    select lr.* into v_req from public.leave_requests lr where lr.id = p_request_id;
    if v_req.id is null then
        raise exception 'Leave request not found';
    end if;
    if not public.is_admin_of(v_req.organisation_id) then
        raise exception 'Not authorised';
    end if;
    if v_req.change_request_type <> 'amend' or v_req.proposed_start_date is null then
        raise exception 'No amendment proposed for this request';
    end if;

    -- 1. Strip old leave hours (old leave type's job, old dates).
    select lt.job_id into v_old_job from public.leave_types lt where lt.id = v_req.leave_type_id;
    if v_old_job is not null then
        v_day := v_req.start_date;
        while v_day <= v_req.end_date loop
            v_dow := extract(isodow from v_day)::int;
            if v_req.skip_weekends and v_dow >= 6 then v_day := v_day + 1; continue; end if;
            v_week_start := v_day - (v_dow - 1);
            select id into v_ts_id from public.timesheets where user_id = v_req.user_id and week_start = v_week_start limit 1;
            if v_ts_id is not null then
                select id into v_entry_id from public.timesheet_entries where timesheet_id = v_ts_id and job_id = v_old_job limit 1;
                if v_entry_id is not null then
                    v_col := case v_dow when 1 then 'mon_hours' when 2 then 'tue_hours' when 3 then 'wed_hours'
                        when 4 then 'thu_hours' when 5 then 'fri_hours' when 6 then 'sat_hours' when 7 then 'sun_hours' end;
                    execute format('update public.timesheet_entries set %I = 0 where id = $1', v_col) using v_entry_id;
                end if;
            end if;
            v_day := v_day + 1;
        end loop;
    end if;

    -- 2. Overwrite live fields with proposed values.
    update public.leave_requests
       set leave_type_id = coalesce(proposed_leave_type_id, leave_type_id),
           start_date    = proposed_start_date,
           end_date      = proposed_end_date,
           hours_per_day = proposed_hours_per_day,
           skip_weekends = coalesce(proposed_skip_weekends, true),
           reason        = coalesce(proposed_reason, reason),
           change_request_type = null, change_request_note = null, change_requested_at = null,
           proposed_leave_type_id = null, proposed_start_date = null, proposed_end_date = null,
           proposed_hours_per_day = null, proposed_skip_weekends = null, proposed_reason = null,
           updated_at = now()
     where id = p_request_id
     returning * into v_req;

    -- 3. Re-populate the timesheet from the new values (new job).
    select lt.job_id into v_new_job from public.leave_types lt where lt.id = v_req.leave_type_id;
    if v_new_job is not null then
        v_day := v_req.start_date;
        while v_day <= v_req.end_date loop
            v_dow := extract(isodow from v_day)::int;
            if v_req.skip_weekends and v_dow >= 6 then v_day := v_day + 1; continue; end if;
            v_week_start := v_day - (v_dow - 1);
            select id into v_ts_id from public.timesheets where user_id = v_req.user_id and week_start = v_week_start limit 1;
            if v_ts_id is null then
                insert into public.timesheets (organisation_id, user_id, week_start, status)
                  values (v_req.organisation_id, v_req.user_id, v_week_start, 'draft') returning id into v_ts_id;
            end if;
            select id into v_entry_id from public.timesheet_entries where timesheet_id = v_ts_id and job_id = v_new_job limit 1;
            if v_entry_id is null then
                insert into public.timesheet_entries (timesheet_id, job_id, description)
                  values (v_ts_id, v_new_job, nullif(trim(coalesce(v_req.reason,'')), '')) returning id into v_entry_id;
            end if;
            v_col := case v_dow when 1 then 'mon_hours' when 2 then 'tue_hours' when 3 then 'wed_hours'
                when 4 then 'thu_hours' when 5 then 'fri_hours' when 6 then 'sat_hours' when 7 then 'sun_hours' end;
            execute format('update public.timesheet_entries set %I = $1 where id = $2', v_col)
              using v_req.hours_per_day, v_entry_id;
            v_day := v_day + 1;
        end loop;
    end if;

    -- Clean up any leave entries left all-zero from the old job.
    if v_old_job is not null then
        delete from public.timesheet_entries e using public.timesheets t
         where e.timesheet_id = t.id and t.user_id = v_req.user_id and e.job_id = v_old_job
           and coalesce(e.mon_hours,0)+coalesce(e.tue_hours,0)+coalesce(e.wed_hours,0)
              +coalesce(e.thu_hours,0)+coalesce(e.fri_hours,0)+coalesce(e.sat_hours,0)
              +coalesce(e.sun_hours,0) = 0;
    end if;
end$$;

grant execute on function public.apply_leave_amendment(bigint) to authenticated;
