-- 043_edit_leave_requests.sql
-- Allow managers/admins to edit or revoke approved leave requests.
-- Edits revert the old timesheet population and re-apply with new values.
--
-- Safe to re-run.

--------------------------------------------------------------------------------
-- clear_leave_from_timesheet (internal helper)
--   Zeros out the hours on the leave job's entries for each day in the
--   request's current range. If an entry has zero hours across the whole
--   week afterwards, it is deleted to keep the grid clean.
--------------------------------------------------------------------------------

create or replace function public.clear_leave_from_timesheet(p_request_id bigint)
returns void
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
    v_total numeric;
begin
    select * into v_req from public.leave_requests where id = p_request_id;
    if v_req.id is null then
        raise exception 'Leave request not found';
    end if;
    if not public.is_manager_of(v_req.organisation_id) then
        raise exception 'Not authorised';
    end if;

    select j.id into v_job_id
      from public.jobs j
      where j.organisation_id = v_req.organisation_id
        and j.is_leave = true
        and j.leave_type_id = v_req.leave_type_id
      limit 1;

    if v_job_id is null then
        -- Nothing to clear — leave job was deleted or reconfigured
        return;
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

        if v_ts_id is not null then
            select id into v_entry_id
              from public.timesheet_entries
              where timesheet_id = v_ts_id and job_id = v_job_id
              limit 1;

            if v_entry_id is not null then
                v_col := case v_dow
                    when 1 then 'mon_hours' when 2 then 'tue_hours'
                    when 3 then 'wed_hours' when 4 then 'thu_hours'
                    when 5 then 'fri_hours' when 6 then 'sat_hours'
                    when 7 then 'sun_hours' end;

                execute format('update public.timesheet_entries set %I = 0 where id = $1', v_col)
                  using v_entry_id;

                -- Clean up entries that are now entirely zero
                execute format($f$
                    delete from public.timesheet_entries
                    where id = $1
                      and mon_hours = 0 and tue_hours = 0 and wed_hours = 0
                      and thu_hours = 0 and fri_hours = 0 and sat_hours = 0
                      and sun_hours = 0
                $f$) using v_entry_id;
            end if;
        end if;

        v_day := v_day + 1;
    end loop;
end;
$$;

grant execute on function public.clear_leave_from_timesheet(bigint) to authenticated;

--------------------------------------------------------------------------------
-- apply_leave_to_timesheet (internal helper — used by approve + update)
--   Populates the employee's timesheet based on the current values in
--   the leave_request row. Extracted from approve_leave_request so it can
--   be reused after an edit.
--------------------------------------------------------------------------------

create or replace function public.apply_leave_to_timesheet(p_request_id bigint)
returns void
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
    select * into v_req from public.leave_requests where id = p_request_id;
    if v_req.id is null then
        raise exception 'Leave request not found';
    end if;
    if not public.is_manager_of(v_req.organisation_id) then
        raise exception 'Not authorised';
    end if;

    select j.id into v_job_id
      from public.jobs j
      where j.organisation_id = v_req.organisation_id
        and j.is_leave = true
        and j.leave_type_id = v_req.leave_type_id
      limit 1;

    if v_job_id is null then
        raise exception 'No leave job configured for this leave type. Ask an admin to create one in Configure > Jobs.';
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
            when 1 then 'mon_hours' when 2 then 'tue_hours'
            when 3 then 'wed_hours' when 4 then 'thu_hours'
            when 5 then 'fri_hours' when 6 then 'sat_hours'
            when 7 then 'sun_hours' end;

        execute format('update public.timesheet_entries set %I = $1 where id = $2', v_col)
          using v_req.hours_per_day, v_entry_id;

        v_day := v_day + 1;
    end loop;
end;
$$;

grant execute on function public.apply_leave_to_timesheet(bigint) to authenticated;

--------------------------------------------------------------------------------
-- update_approved_leave_request
--   Manager/admin edits an already-approved leave. Reverts old timesheet
--   population, updates the request, and re-applies with new values.
--------------------------------------------------------------------------------

create or replace function public.update_approved_leave_request(
    p_request_id      bigint,
    p_leave_type_id   bigint,
    p_start_date      date,
    p_end_date        date,
    p_hours_per_day   numeric,
    p_skip_weekends   boolean,
    p_reason          text default null
)
returns void
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_req public.leave_requests;
begin
    select * into v_req from public.leave_requests where id = p_request_id;
    if v_req.id is null then
        raise exception 'Leave request not found';
    end if;
    if not public.is_manager_of(v_req.organisation_id) then
        raise exception 'Not authorised';
    end if;
    if v_req.status <> 'approved' then
        raise exception 'Only approved requests can be edited';
    end if;
    if p_end_date < p_start_date then
        raise exception 'End date must be on or after start date';
    end if;

    -- 1. Clear the old timesheet population
    perform public.clear_leave_from_timesheet(p_request_id);

    -- 2. Update the request with new values
    update public.leave_requests
       set leave_type_id = p_leave_type_id,
           start_date    = p_start_date,
           end_date      = p_end_date,
           hours_per_day = p_hours_per_day,
           skip_weekends = p_skip_weekends,
           reason        = p_reason,
           updated_at    = now()
       where id = p_request_id;

    -- 3. Re-apply with the new values
    perform public.apply_leave_to_timesheet(p_request_id);
end;
$$;

grant execute on function public.update_approved_leave_request(bigint, bigint, date, date, numeric, boolean, text) to authenticated;

--------------------------------------------------------------------------------
-- revoke_leave_request
--   Manager/admin cancels an approved leave. Clears the timesheet
--   population and marks the request as cancelled.
--------------------------------------------------------------------------------

create or replace function public.revoke_leave_request(
    p_request_id bigint,
    p_note text default null
)
returns void
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_req public.leave_requests;
    v_reviewer_id bigint;
begin
    select * into v_req from public.leave_requests where id = p_request_id;
    if v_req.id is null then
        raise exception 'Leave request not found';
    end if;
    if not public.is_manager_of(v_req.organisation_id) then
        raise exception 'Not authorised';
    end if;
    if v_req.status <> 'approved' then
        raise exception 'Only approved requests can be revoked';
    end if;

    select u.id into v_reviewer_id
      from public.users u
      where u.auth_user_id = auth.uid()
        and u.organisation_id = v_req.organisation_id
      limit 1;

    perform public.clear_leave_from_timesheet(p_request_id);

    update public.leave_requests
       set status = 'cancelled',
           reviewed_by = v_reviewer_id,
           reviewed_at = now(),
           review_note = p_note,
           applied_to_timesheet = false,
           updated_at = now()
       where id = p_request_id;
end;
$$;

grant execute on function public.revoke_leave_request(bigint, text) to authenticated;
