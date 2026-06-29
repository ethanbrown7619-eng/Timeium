-- 135_team_leave_skip_weekends.sql
-- Add skip_weekends to list_team_leave_requests so the manager Team
-- Requests tab can compute the total-hours column the same way the
-- employee's own view does (hours/day × leave days, weekends excluded
-- when skip_weekends is set).
--
-- Safe to re-run.

-- Adding skip_weekends changes the function's return columns, and
-- create-or-replace can't alter a function's return type — drop first.
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
    status          text
)
language plpgsql stable security definer set search_path = public
as $$
begin
    return query
    select lr.id, lr.user_id, u.name, lt.name,
           lr.start_date, lr.end_date, lr.hours_per_day, lr.skip_weekends,
           lr.reason, lr.status
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
