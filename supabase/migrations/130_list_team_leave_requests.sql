-- 130_list_team_leave_requests.sql
-- SECURITY DEFINER reader for the manager "Team Requests" tab on the
-- My Leave page. RLS on leave_requests only grants SELECT of other
-- people's requests to admins-table managers (is_manager_of), so a pure
-- department lead — someone set as departments.manager_id but NOT in the
-- admins table — couldn't see their team's requests at all. This RPC
-- bridges that: it returns requests for any employee whose department
-- the caller manages, plus (for admins) the whole org.
--
-- Mirrors the auth model of the write RPCs from migration 126
-- (user_manages_target_user OR is_admin_of).
--
-- Safe to re-run.

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
    reason          text,
    status          text
)
language plpgsql stable security definer set search_path = public
as $$
begin
    return query
    select lr.id, lr.user_id, u.name, lt.name,
           lr.start_date, lr.end_date, lr.hours_per_day, lr.reason, lr.status
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
