-- 109_timesheet_exported_status.sql
-- Adds 'exported' as a terminal status for timesheets so the Infusion
-- export can be re-run for late submissions without re-exporting rows
-- that already went to payroll.
--
-- Flow with the new status:
--   draft -> submitted -> approved -> exported  (happy path)
--   submitted -> rejected -> draft -> submitted -> approved -> exported
--   exported (terminal — locked from employee edits, same as approved)
--
-- The Excel export query filters on status = 'approved' (existing
-- behaviour) and the handler updates the rows it pulled to 'exported'
-- after writing the file. A later run for the same week picks up only
-- approved rows that weren't previously exported.
--
-- A developer-only RPC reset_to_approved(p_timesheet_id) provides the
-- escape hatch for the "I lost the file / payroll never got it"
-- scenario. Gated on public.is_developer().
--
-- Idempotent. The CHECK is dropped before being re-added to widen the
-- allowlist.

alter table public.timesheets
    drop constraint if exists timesheets_status_check;

alter table public.timesheets
    add constraint timesheets_status_check
    check (status in ('draft','submitted','approved','rejected','exported'));

-- Existing user/admin/manager RLS policies on public.timesheets accept
-- any status value the WITH CHECK clause permits. Update those that
-- mention specific status sets so 'exported' is handled correctly:
--
-- - "users update own unlocked timesheets" (054) already requires the
--   row's status to be in ('draft','rejected') under USING — exported
--   rows stay locked from the employee. No change needed.
-- - "managers update dept timesheets" (102) flips submitted -> approved
--   or rejected; doesn't touch exported. No change needed.
-- - "admins manage org timesheets" (031) is FOR ALL — admins can flip
--   approved -> exported (Infusion handler does this) and exported
--   -> approved (dev revert RPC). No change needed.

create or replace function public.reset_to_approved(p_timesheet_id bigint)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
    v_row record;
begin
    if not public.is_developer() then
        raise exception 'Not authorised';
    end if;
    select id, status into v_row from public.timesheets where id = p_timesheet_id;
    if not found then raise exception 'Timesheet not found'; end if;
    if v_row.status <> 'exported' then
        raise exception 'Timesheet is not in exported status (current: %)', v_row.status;
    end if;
    update public.timesheets set status = 'approved' where id = p_timesheet_id;
    return true;
end;
$$;

revoke all on function public.reset_to_approved(bigint) from public;
grant execute on function public.reset_to_approved(bigint) to authenticated;
