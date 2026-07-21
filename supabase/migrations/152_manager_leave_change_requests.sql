-- 152_manager_leave_change_requests.sql
-- Cancellation and amendment requests on approved leave are now the
-- MANAGER's job to action, not the admin's. Admins keep full visibility
-- (and can still act as an override) via the Admin > Leave > Change
-- requests sub-tab, but the day-to-day flow is:
--   employee requests cancel/amend → their manager actions it from
--   Leave > Team Requests.
--
-- Changes:
--   - revoke_leave_request / dismiss_leave_change_request /
--     apply_leave_amendment: auth widened from admin-only to
--     admin OR manager-of-the-employee (user_manages_target_user).
--   - new list_team_leave_change_requests RPC: the manager's view of
--     approved leave in their team with a pending change request.
--
-- Safe to re-run.

--------------------------------------------------------------------------------
-- revoke_leave_request — manager or admin pulls approved leave back off
-- the timesheet and marks it cancelled. Body from migration 136; only
-- the auth check changed.
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
    if not (public.is_admin_of(v_req.organisation_id)
            or public.user_manages_target_user(v_req.user_id)) then
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
-- dismiss_leave_change_request — manager or admin clears the change
-- flag, leave stays approved as-is.
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
    if not (public.is_admin_of(v_req.organisation_id)
            or public.user_manages_target_user(v_req.user_id)) then
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

--------------------------------------------------------------------------------
-- apply_leave_amendment — manager or admin applies the proposed values.
-- Body from migration 138; only the auth check changed.
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
    if not (public.is_admin_of(v_req.organisation_id)
            or public.user_manages_target_user(v_req.user_id)) then
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

--------------------------------------------------------------------------------
-- list_team_leave_change_requests — the manager's change-request queue:
-- approved leave in their team with a pending cancel/amend request.
-- Admins see the whole org (same visibility rule as
-- list_team_leave_requests).
--------------------------------------------------------------------------------

create or replace function public.list_team_leave_change_requests(p_org_id bigint)
returns table (
    id                      bigint,
    user_id                 bigint,
    employee_name           text,
    leave_type_name         text,
    start_date              date,
    end_date                date,
    hours_per_day           numeric,
    skip_weekends           boolean,
    reason                  text,
    change_request_type     text,
    change_request_note     text,
    change_requested_at     timestamptz,
    proposed_start_date     date,
    proposed_end_date       date,
    proposed_hours_per_day  numeric,
    proposed_skip_weekends  boolean,
    proposed_leave_type_name text
)
language plpgsql stable security definer set search_path = public
as $$
begin
    return query
    select lr.id, lr.user_id, u.name, lt.name,
           lr.start_date, lr.end_date, lr.hours_per_day, lr.skip_weekends,
           lr.reason, lr.change_request_type, lr.change_request_note, lr.change_requested_at,
           lr.proposed_start_date, lr.proposed_end_date, lr.proposed_hours_per_day,
           lr.proposed_skip_weekends, plt.name
      from public.leave_requests lr
      join public.users u        on u.id = lr.user_id
      left join public.leave_types lt  on lt.id = lr.leave_type_id
      left join public.leave_types plt on plt.id = lr.proposed_leave_type_id
     where lr.organisation_id = p_org_id
       and lr.status = 'approved'
       and lr.change_request_type is not null
       and (public.is_admin_of(p_org_id)
            or public.user_manages_target_user(lr.user_id))
     order by lr.change_requested_at;
end$$;

grant execute on function public.list_team_leave_change_requests(bigint) to authenticated;
