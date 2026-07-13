-- 148_require_department_on_submit.sql
-- Company rule: no timesheet may reach 'submitted' with hour-bearing
-- rows that have no department code. The employee flow validates this
-- client-side and admin_submit_timesheet validates it in the RPC
-- (migration 123), but the employee submit is a plain UPDATE on
-- timesheets, so a stale client (or anything else writing the table)
-- could still flip status with the check skipped. A trigger on the
-- status transition closes every path at once.
--
-- Same exemptions as the existing checks:
--   - zero-hour rows (empty filler, not a violation)
--   - leave-job rows (leave carries its own categorisation; the dept
--     cell isn't even rendered for those)
--
-- Runs with invoker rights: employees can read their own entries and
-- jobs under RLS, and admin_submit_timesheet is SECURITY DEFINER, so
-- both paths can evaluate the check.
--
-- Safe to re-run.

create or replace function public.check_timesheet_dept_on_submit()
returns trigger
language plpgsql
as $$
declare
    v_missing integer;
begin
    if new.status = 'submitted' and old.status is distinct from new.status then
        select count(*)
          into v_missing
          from public.timesheet_entries e
          left join public.jobs j on j.id = e.job_id
         where e.timesheet_id = new.id
           and not coalesce(j.is_leave, false)
           and (coalesce(e.mon_hours, 0)
              + coalesce(e.tue_hours, 0)
              + coalesce(e.wed_hours, 0)
              + coalesce(e.thu_hours, 0)
              + coalesce(e.fri_hours, 0)
              + coalesce(e.sat_hours, 0)
              + coalesce(e.sun_hours, 0)) > 0
           and e.dept_code_id is null;

        if v_missing > 0 then
            raise exception 'Cannot submit: % row(s) have hours but no department selected', v_missing;
        end if;
    end if;
    return new;
end$$;

drop trigger if exists trg_timesheet_require_department on public.timesheets;
create trigger trg_timesheet_require_department
    before update of status on public.timesheets
    for each row
    execute function public.check_timesheet_dept_on_submit();
