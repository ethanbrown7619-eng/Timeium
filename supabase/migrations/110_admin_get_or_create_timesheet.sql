-- 110_admin_get_or_create_timesheet.sql
-- Admins can edit any employee's timesheet (Timesheet view → Edit (admin)
-- button), and previously the admin-mode path in timesheet.js did a
-- manual SELECT … then INSERT to materialise a draft row if one didn't
-- exist. That re-introduces the SELECT-then-INSERT race fixed in 055
-- for the employee's own get_or_create_timesheet flow.
--
-- This RPC mirrors 055's pattern (INSERT … ON CONFLICT DO UPDATE …
-- RETURNING id) but takes p_user_id explicitly and gates on admin
-- privileges instead of auth.uid()'s own row. Result: two admins (or
-- an admin + the employee) opening the same fresh week at the same
-- instant always converge on a single canonical timesheet row.

create or replace function public.admin_get_or_create_timesheet(
    p_user_id     bigint,
    p_week_start  date
)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
    v_org_id bigint;
    v_ts_id  bigint;
begin
    select organisation_id into v_org_id
      from public.users
     where id = p_user_id;
    if v_org_id is null then
        raise exception 'User not found';
    end if;
    if not public.is_admin_of(v_org_id) then
        raise exception 'Not authorised';
    end if;

    insert into public.timesheets (organisation_id, user_id, week_start)
    values (v_org_id, p_user_id, p_week_start)
    on conflict (user_id, week_start) do update set id = public.timesheets.id
    returning id into v_ts_id;

    return v_ts_id;
end$$;

revoke all on function public.admin_get_or_create_timesheet(bigint, date) from public;
grant execute on function public.admin_get_or_create_timesheet(bigint, date) to authenticated;
