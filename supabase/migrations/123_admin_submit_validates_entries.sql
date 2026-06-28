-- 123_admin_submit_validates_entries.sql
-- Submit-on-behalf used to skip the per-row job/department/task validation
-- that timesheet.js applies before the regular submit. Managers could
-- flip a draft → submitted with rows missing a department, which the
-- normal flow would have blocked. Closing the gap in the RPC so the
-- check can't be bypassed regardless of which UI path is used.
--
-- Skips:
--   - rows with zero hours (incomplete = expected, not a violation)
--   - leave-job rows (department isn't entered on those — the leave job
--     itself carries the categorisation)
-- Checks:
--   - job_id set
--   - dept_code_id set
--   - task_id set when the user's department has require_task = true
--
-- Safe to re-run.

create or replace function public.admin_submit_timesheet(p_timesheet_id bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    v_org_id        bigint;
    v_user_id       bigint;
    v_status        text;
    v_dept_id       bigint;
    v_require_task  boolean;
    v_missing_dept  integer;
    v_missing_job   integer;
    v_missing_task  integer;
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

    -- Look up the employee's department to know if require_task applies.
    select u.department_id, coalesce(d.require_task, false)
      into v_dept_id, v_require_task
      from public.users u
      left join public.departments d on d.id = u.department_id
     where u.id = v_user_id;

    -- Find entries that violate the per-row rules. Only entries with at
    -- least one day of hours are checked; empty rows are tolerated.
    select
        count(*) filter (where e.dept_code_id is null) ,
        count(*) filter (where e.job_id is null) ,
        count(*) filter (where v_require_task and e.task_id is null)
      into v_missing_dept, v_missing_job, v_missing_task
      from public.timesheet_entries e
      left join public.jobs j on j.id = e.job_id
     where e.timesheet_id = p_timesheet_id
       and not coalesce(j.is_leave, false)
       and (coalesce(e.mon_hours, 0)
          + coalesce(e.tue_hours, 0)
          + coalesce(e.wed_hours, 0)
          + coalesce(e.thu_hours, 0)
          + coalesce(e.fri_hours, 0)
          + coalesce(e.sat_hours, 0)
          + coalesce(e.sun_hours, 0)) > 0;

    if v_missing_job > 0 then
        raise exception 'Cannot submit: % row(s) have hours but no job selected', v_missing_job;
    end if;
    if v_missing_dept > 0 then
        raise exception 'Cannot submit: % row(s) have hours but no department selected', v_missing_dept;
    end if;
    if v_missing_task > 0 then
        raise exception 'Cannot submit: % row(s) have hours but no task selected (required by this department)', v_missing_task;
    end if;

    update public.timesheets
       set status       = 'submitted',
           submitted_at = now(),
           updated_at   = now()
     where id = p_timesheet_id
       and status in ('draft', 'rejected');
end$$;

grant execute on function public.admin_submit_timesheet(bigint) to authenticated;
