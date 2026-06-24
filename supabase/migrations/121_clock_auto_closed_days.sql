-- 121_clock_auto_closed_days.sql
-- The Full Clock report needs to know which (user, day) pairs were
-- auto-closed so the UI can prefer the yellow "Auto-closed" badge over
-- the red "Short shift" badge when both apply on the same shift. The
-- shared weekly_timesheet RPC only returns a single flag with its own
-- internal priority (red wins), and that RPC lives in the sibling
-- Clock In/Out repo where we don't push migrations from here.
--
-- This RPC exposes the auto_closed signal directly so the Full report
-- can resolve priority client-side. SECURITY DEFINER + explicit auth
-- check so admins and clock viewers (who can't read clock_events
-- directly under existing RLS) both get a useful answer.
--
-- Safe to re-run.

create or replace function public.clock_auto_closed_days(
    p_org_id    bigint,
    p_start     date,
    p_end_excl  date,
    p_tz        text default null
)
returns table (user_id bigint, day date)
language plpgsql stable security definer set search_path = public
as $$
declare
    v_tz       text;
    v_authed   boolean;
begin
    -- Allow admins of the org and anyone flagged can_view_clock_comparison.
    -- Mirrors the access boundary of the weekly_timesheet RPC.
    v_authed := public.is_admin_of(p_org_id)
             or exists (
                 select 1 from public.users u
                 where u.auth_user_id = auth.uid()
                   and u.organisation_id = p_org_id
                   and u.can_view_clock_comparison = true
             );
    if not v_authed then
        raise exception 'Not authorised';
    end if;

    v_tz := coalesce(p_tz,
              (select s.timezone from public.app_settings s where s.organisation_id = p_org_id),
              'UTC');

    return query
    select distinct e.user_id,
           ((e.occurred_at at time zone v_tz)::date) as day
      from public.clock_events e
      join public.users u on u.id = e.user_id
     where u.organisation_id = p_org_id
       and e.auto_closed = true
       and e.occurred_at >= (p_start::timestamp) at time zone v_tz
       and e.occurred_at <  (p_end_excl::timestamp) at time zone v_tz;
end$$;

grant execute on function public.clock_auto_closed_days(bigint, date, date, text) to authenticated;
