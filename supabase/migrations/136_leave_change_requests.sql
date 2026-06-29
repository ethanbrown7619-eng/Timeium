-- 136_leave_change_requests.sql
-- Lets an employee request a CHANGE to leave that's already approved —
-- either cancellation or amendment. Pre-approval requests can still be
-- cancelled outright (cancel_leave_request, migration 128); this covers
-- the post-approval case where a manager/admin must action it because
-- the leave is already on the timesheet.
--
-- Model: a flag on the approved row rather than a separate table.
--   change_request_type  'cancel' | 'amend' | null
--   change_request_note  employee's note (esp. for amend — what to change)
--   change_requested_at  when they asked
-- The admin Leave queue surfaces rows where change_request_type is set.
--
-- RPCs:
--   request_leave_change(req, type, note) — employee flags own approved row
--   revoke_leave_request(req, note)        — admin: pull the leave back off
--                                            the timesheet, set cancelled
--   dismiss_leave_change_request(req)      — admin: clear the flag, leave
--                                            stays approved as-is
--
-- Safe to re-run.

alter table public.leave_requests
    add column if not exists change_request_type text
        check (change_request_type in ('cancel', 'amend')),
    add column if not exists change_request_note text,
    add column if not exists change_requested_at  timestamptz;

--------------------------------------------------------------------------------
-- request_leave_change — employee flags their own approved leave.
--------------------------------------------------------------------------------

create or replace function public.request_leave_change(
    p_request_id bigint,
    p_type       text,
    p_note       text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    v_req     public.leave_requests;
    v_user_id bigint;
begin
    if p_type not in ('cancel', 'amend') then
        raise exception 'type must be cancel or amend';
    end if;

    select lr.* into v_req from public.leave_requests lr where lr.id = p_request_id;
    if v_req.id is null then
        raise exception 'Leave request not found';
    end if;
    if v_req.status <> 'approved' then
        raise exception 'Only approved leave can have a change requested (current: %)', v_req.status;
    end if;

    select u.id into v_user_id
      from public.users u where u.auth_user_id = auth.uid() limit 1;
    if v_user_id is null or v_user_id <> v_req.user_id then
        raise exception 'Not authorised — you can only change your own leave';
    end if;

    update public.leave_requests
       set change_request_type = p_type,
           change_request_note = p_note,
           change_requested_at = now(),
           updated_at = now()
     where id = p_request_id;
end$$;

grant execute on function public.request_leave_change(bigint, text, text) to authenticated;

--------------------------------------------------------------------------------
-- revoke_leave_request — admin pulls approved leave back off the
-- timesheet and marks it cancelled. Handles both an outright admin
-- revoke and the employee-requested cancellation/amendment (for amend,
-- the employee then submits a fresh corrected request).
--------------------------------------------------------------------------------

create or replace function public.revoke_leave_request(
    p_request_id bigint,
    p_note text default null
)
returns void
language plpgsql security definer set search_path = public
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
    if not public.is_admin_of(v_req.organisation_id) then
        raise exception 'Not authorised';
    end if;
    if v_req.status <> 'approved' then
        raise exception 'Only approved leave can be revoked (current: %)', v_req.status;
    end if;

    -- Zero the leave hours we previously populated, day by day.
    select lt.job_id into v_job_id
      from public.leave_types lt where lt.id = v_req.leave_type_id;

    if v_job_id is not null then
        v_day := v_req.start_date;
        while v_day <= v_req.end_date loop
            v_dow := extract(isodow from v_day)::int;
            if v_req.skip_weekends and v_dow >= 6 then
                v_day := v_day + 1; continue;
            end if;
            v_week_start := v_day - (v_dow - 1);

            select id into v_ts_id from public.timesheets
             where user_id = v_req.user_id and week_start = v_week_start limit 1;
            if v_ts_id is not null then
                select id into v_entry_id from public.timesheet_entries
                 where timesheet_id = v_ts_id and job_id = v_job_id limit 1;
                if v_entry_id is not null then
                    v_col := case v_dow
                        when 1 then 'mon_hours' when 2 then 'tue_hours' when 3 then 'wed_hours'
                        when 4 then 'thu_hours' when 5 then 'fri_hours'
                        when 6 then 'sat_hours' when 7 then 'sun_hours' end;
                    execute format('update public.timesheet_entries set %I = 0 where id = $1', v_col)
                      using v_entry_id;
                end if;
            end if;
            v_day := v_day + 1;
        end loop;

        -- Drop any leave entries left at all-zero so the timesheet isn't
        -- cluttered with empty rows.
        delete from public.timesheet_entries e
         using public.timesheets t
         where e.timesheet_id = t.id
           and t.user_id = v_req.user_id
           and e.job_id = v_job_id
           and coalesce(e.mon_hours,0)+coalesce(e.tue_hours,0)+coalesce(e.wed_hours,0)
              +coalesce(e.thu_hours,0)+coalesce(e.fri_hours,0)+coalesce(e.sat_hours,0)
              +coalesce(e.sun_hours,0) = 0;
    end if;

    update public.leave_requests
       set status = 'cancelled',
           review_note = coalesce(p_note, review_note),
           change_request_type = null,
           change_request_note = null,
           change_requested_at = null,
           applied_to_timesheet = false,
           updated_at = now()
     where id = p_request_id;
end$$;

grant execute on function public.revoke_leave_request(bigint, text) to authenticated;

--------------------------------------------------------------------------------
-- dismiss_leave_change_request — admin clears the change flag, leave
-- stays approved as-is (e.g. the change was discussed and declined).
--------------------------------------------------------------------------------

create or replace function public.dismiss_leave_change_request(p_request_id bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    v_req public.leave_requests;
begin
    select lr.* into v_req from public.leave_requests lr where lr.id = p_request_id;
    if v_req.id is null then
        raise exception 'Leave request not found';
    end if;
    if not public.is_admin_of(v_req.organisation_id) then
        raise exception 'Not authorised';
    end if;
    update public.leave_requests
       set change_request_type = null,
           change_request_note = null,
           change_requested_at = null,
           updated_at = now()
     where id = p_request_id;
end$$;

grant execute on function public.dismiss_leave_change_request(bigint) to authenticated;
