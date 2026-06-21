-- 119_manager_submit_timesheet.sql
-- Extends admin_submit_timesheet (115/116) so managers can also (re)submit
-- a draft or rejected timesheet on behalf of an employee they manage —
-- parity with the edit / create capabilities granted in 118.
--
-- Same name, same signature → no frontend RPC call changes. The auth
-- check now passes for either is_admin_of(org) OR user_manages_target_user
-- of the timesheet's owner.
--
-- Safe to re-run.

create or replace function public.admin_submit_timesheet(p_timesheet_id bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    v_org_id  bigint;
    v_user_id bigint;
    v_status  text;
begin
    select organisation_id, user_id, status
      into v_org_id, v_user_id, v_status
      from public.timesheets
     where id = p_timesheet_id;

    if v_org_id is null then
        raise exception 'Timesheet not found';
    end if;
    if not (public.is_admin_of(v_org_id) or public.user_manages_target_user(v_user_id)) then
        raise exception 'Not authorised';
    end if;
    if v_status not in ('draft', 'rejected') then
        raise exception 'Only draft or rejected timesheets can be submitted on behalf — current status: %', v_status;
    end if;

    update public.timesheets
       set status       = 'submitted',
           submitted_at = now(),
           updated_at   = now()
     where id = p_timesheet_id
       and status in ('draft', 'rejected');
end$$;

grant execute on function public.admin_submit_timesheet(bigint) to authenticated;
