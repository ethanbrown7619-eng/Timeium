-- 122_clock_unpaid_breaks.sql
-- Clock-vs-Timesheet compares hours logged on a timesheet to hours
-- worked according to the clock app. The "worked" side should exclude
-- only UNPAID breaks — paid breaks are paid time and count as worked.
-- The shared weekly_timesheet RPC returns a single break_minutes value
-- summing both paid and unpaid; this RPC exposes the unpaid break
-- config so the client can re-derive worked = raw - unpaid_break.
--
-- SECURITY DEFINER with explicit admin / clock-viewer auth check (same
-- boundary as weekly_timesheet) — the breaks table is otherwise
-- admin-only under existing RLS.
--
-- Safe to re-run.

create or replace function public.clock_unpaid_breaks(p_org_id bigint)
returns table (duration_minutes integer, trigger_hours_into_shift numeric)
language plpgsql stable security definer set search_path = public
as $$
declare
    v_authed boolean;
begin
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

    return query
    select b.duration_minutes, b.trigger_hours_into_shift
      from public.breaks b
     where b.organisation_id = p_org_id
       and b.active = true
       and b.paid = false;
end$$;

grant execute on function public.clock_unpaid_breaks(bigint) to authenticated;
