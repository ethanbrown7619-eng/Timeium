-- 116_admin_submit_rejected.sql
-- Extends admin_submit_timesheet (115) to also accept 'rejected' as a
-- valid prior state. Use case: manager rejects a timesheet, admin opens
-- it and corrects the issue themselves, then needs to resubmit on the
-- employee's behalf — previously the admin was blocked at this step
-- because the RPC only allowed 'draft'.
--
-- 'submitted', 'approved', and 'exported' remain refused (those have
-- their own action paths or are terminal).
--
-- Safe to re-run — uses create or replace.

create or replace function public.admin_submit_timesheet(p_timesheet_id bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    v_org_id bigint;
    v_status text;
begin
    select organisation_id, status
      into v_org_id, v_status
      from public.timesheets
     where id = p_timesheet_id;

    if v_org_id is null then
        raise exception 'Timesheet not found';
    end if;
    if not public.is_admin_of(v_org_id) then
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
       and status in ('draft', 'rejected');  -- guard against concurrent state change
end$$;

grant execute on function public.admin_submit_timesheet(bigint) to authenticated;
