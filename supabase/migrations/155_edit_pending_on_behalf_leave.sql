-- 155_edit_pending_on_behalf_leave.sql
-- Let an admin (or the employee's manager) EDIT an on-behalf leave
-- request while it's still awaiting the employee's acceptance
-- (status = 'pending_employee') — so a mistake in the dates/type/hours
-- can be corrected instead of declining and re-raising.
--
-- (Migration number 154 is reserved for the _timesheet_rows /
-- _offsite_report restoration being coordinated with the PTL Clock repo.)
--
--   - update_pending_leave_request: new RPC, admin-or-manager gated,
--     only touches pending_employee rows.
--   - cancel_pending_leave_request: new RPC, same gate — withdraws an
--     on-behalf request before the employee accepts it.
--   - list_team_leave_requests: recreated to also return leave_type_id
--     (and requested_by) so the edit dialog can prefill; extra columns
--     appended, existing callers unaffected.
--
-- Safe to re-run.

--------------------------------------------------------------------------------
-- update_pending_leave_request
--------------------------------------------------------------------------------

create or replace function public.update_pending_leave_request(
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
    v_req public.leave_requests;
begin
    select lr.* into v_req from public.leave_requests lr where lr.id = p_request_id;
    if v_req.id is null then
        raise exception 'Leave request not found';
    end if;
    if v_req.status <> 'pending_employee' then
        raise exception 'Only requests still awaiting employee acceptance can be edited (current: %)', v_req.status;
    end if;
    if not (public.is_admin_of(v_req.organisation_id)
            or public.user_manages_target_user(v_req.user_id)) then
        raise exception 'Not authorised to edit this request';
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

    update public.leave_requests
       set leave_type_id = p_leave_type_id,
           start_date    = p_start_date,
           end_date      = p_end_date,
           hours_per_day = p_hours_per_day,
           skip_weekends = coalesce(p_skip_weekends, true),
           reason        = p_reason,
           updated_at    = now()
     where id = p_request_id;
end$$;

grant execute on function public.update_pending_leave_request(bigint, bigint, date, date, numeric, boolean, text) to authenticated;

--------------------------------------------------------------------------------
-- cancel_pending_leave_request — withdraw an on-behalf request the
-- employee hasn't accepted yet.
--------------------------------------------------------------------------------

create or replace function public.cancel_pending_leave_request(
    p_request_id bigint,
    p_note text default null
)
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
    if v_req.status <> 'pending_employee' then
        raise exception 'Only requests still awaiting employee acceptance can be cancelled here (current: %)', v_req.status;
    end if;
    if not (public.is_admin_of(v_req.organisation_id)
            or public.user_manages_target_user(v_req.user_id)) then
        raise exception 'Not authorised to cancel this request';
    end if;

    update public.leave_requests
       set status = 'cancelled',
           review_note = coalesce(p_note, 'Withdrawn by requester'),
           updated_at = now()
     where id = p_request_id;
end$$;

grant execute on function public.cancel_pending_leave_request(bigint, text) to authenticated;

--------------------------------------------------------------------------------
-- list_team_leave_requests — + leave_type_id, requested_by (appended)
--------------------------------------------------------------------------------

drop function if exists public.list_team_leave_requests(bigint, text);

create or replace function public.list_team_leave_requests(
    p_org_id bigint,
    p_status text
)
returns table (
    id              bigint,
    user_id         bigint,
    employee_name   text,
    leave_type_name text,
    start_date      date,
    end_date        date,
    hours_per_day   numeric,
    skip_weekends   boolean,
    reason          text,
    status          text,
    leave_type_id   bigint,
    requested_by    bigint
)
language plpgsql stable security definer set search_path = public
as $$
begin
    return query
    select lr.id, lr.user_id, u.name, lt.name,
           lr.start_date, lr.end_date, lr.hours_per_day, lr.skip_weekends,
           lr.reason, lr.status, lr.leave_type_id, lr.requested_by
      from public.leave_requests lr
      join public.users u       on u.id = lr.user_id
      left join public.leave_types lt on lt.id = lr.leave_type_id
     where lr.organisation_id = p_org_id
       and lr.status = p_status
       and (public.is_admin_of(p_org_id)
            or public.user_manages_target_user(lr.user_id))
     order by lr.created_at;
end$$;

grant execute on function public.list_team_leave_requests(bigint, text) to authenticated;
