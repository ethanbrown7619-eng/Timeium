-- 115_admin_submit_timesheet.sql
-- Admins can submit a draft timesheet on behalf of a staff member who
-- forgot or can't access the app. RLS otherwise only lets the owner flip
-- draft → submitted, so this is the escape hatch.
--
-- Refuses anything that isn't currently 'draft' — admins still go through
-- the normal approve/reject path for 'submitted', and we don't want to
-- silently rewind 'rejected' or 'approved' rows from this entrypoint.
--
-- Safe to re-run.

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
    if v_status <> 'draft' then
        raise exception 'Only draft timesheets can be submitted on behalf — current status: %', v_status;
    end if;

    update public.timesheets
       set status       = 'submitted',
           submitted_at = now(),
           updated_at   = now()
     where id = p_timesheet_id
       and status = 'draft';  -- guard against concurrent state change
end$$;

grant execute on function public.admin_submit_timesheet(bigint) to authenticated;
