-- 156_org_leave_calendar.sql
-- Privacy-limited leave feed for the shared ERP calendars: the Timesheet
-- page's new Calendar sub-tab and the Map module's Calendar tab (map owns
-- the calendar machinery) both render approved leave as "Name — Leave"
-- events. Deliberately returns NO leave type, reason, hours, or review
-- data — any signed-in org member may call it, so the payload is only
-- who is away and on which days.
--
-- leave_requests RLS hides colleagues' rows from regular staff, hence
-- SECURITY DEFINER with its own membership check (same bridge pattern as
-- org_on_leave_today, migration 134, but open to every org member).
--
-- Clients expand [start_date, end_date] into per-day events themselves,
-- honouring skip_weekends.
--
-- Safe to re-run.

create or replace function public.org_leave_calendar(
    p_org_id bigint,
    p_from   date,
    p_to     date
)
returns table (
    user_id       bigint,
    employee_name text,
    start_date    date,
    end_date      date,
    skip_weekends boolean
)
language plpgsql stable security definer set search_path = public
as $$
declare
    v_authed boolean;
begin
    v_authed := exists (
                    select 1 from public.users u
                    where u.auth_user_id = auth.uid()
                      and u.organisation_id = p_org_id
                )
             or public.is_admin_of(p_org_id)
             or public.is_manager_of(p_org_id)
             or public.is_developer();
    if not v_authed then
        raise exception 'Not authorised';
    end if;

    return query
    select lr.user_id, u.name, lr.start_date, lr.end_date, lr.skip_weekends
      from public.leave_requests lr
      join public.users u on u.id = lr.user_id
     where lr.organisation_id = p_org_id
       and lr.status = 'approved'
       and lr.start_date <= p_to
       and lr.end_date   >= p_from
     order by u.name, lr.start_date;
end$$;

grant execute on function public.org_leave_calendar(bigint, date, date) to authenticated;
