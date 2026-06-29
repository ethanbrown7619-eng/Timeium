-- 134_org_on_leave_today.sql
-- Returns the employees on approved leave for a given local date, so the
-- live Clock presence view can show "Sick Leave" / "Annual Leave" etc.
-- instead of "Not clocked in" for people who are legitimately away.
--
-- SECURITY DEFINER with the same access boundary as the rest of the
-- clock view: admins, managers, and clock-comparison viewers of the org.
-- (leave_requests RLS would otherwise hide all rows from a clock-viewer
-- who isn't an admin/manager.)
--
-- Respects skip_weekends: a request that skips weekends doesn't count a
-- Sat/Sun as a leave day.
--
-- Safe to re-run.

create or replace function public.org_on_leave_today(
    p_org_id bigint,
    p_today  date
)
returns table (
    user_id         bigint,
    name            text,
    leave_type_name text
)
language plpgsql stable security definer set search_path = public
as $$
declare
    v_authed boolean;
    v_dow    int;
begin
    v_authed := public.is_admin_of(p_org_id)
             or public.is_manager_of(p_org_id)
             or exists (
                 select 1 from public.users u
                 where u.auth_user_id = auth.uid()
                   and u.organisation_id = p_org_id
                   and u.can_view_clock_comparison = true
             );
    if not v_authed then
        raise exception 'Not authorised';
    end if;

    v_dow := extract(isodow from p_today)::int;  -- 6=Sat, 7=Sun

    return query
    select lr.user_id, u.name, lt.name
      from public.leave_requests lr
      join public.users u       on u.id = lr.user_id
      left join public.leave_types lt on lt.id = lr.leave_type_id
     where lr.organisation_id = p_org_id
       and lr.status = 'approved'
       and p_today between lr.start_date and lr.end_date
       and not (lr.skip_weekends and v_dow >= 6);
end$$;

grant execute on function public.org_on_leave_today(bigint, date) to authenticated;
