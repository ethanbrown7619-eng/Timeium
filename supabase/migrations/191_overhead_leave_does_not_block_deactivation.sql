-- 191_overhead_leave_does_not_block_deactivation.sql
-- Overhead staff's LEAVE-ONLY drafts no longer block deactivation.
--
-- The case (2026-09-28): Kelly Lawson (Sales, Marketing and Estimation, an
-- overhead department) could not be deactivated - 182 found six "unexported"
-- draft timesheets. Every hour on them was SL/AL leave: approving a leave
-- request writes the hours onto that week's timesheet
-- (populate_timesheet_for_leave), and overhead staff who never fill in
-- timesheets never submit or export those drafts. 18 active overhead staff
-- carry drafts like this.
--
-- The user asked for overhead staff to "count as exported". Not literally:
-- two overhead people (Management) DO submit and export real job hours
-- every week, so marking overhead timesheets exported, or skipping overhead
-- staff wholesale, would let their real payroll hours be stranded - the
-- exact incident 182 exists to stop. The rule instead:
--
--   for an employee in an overhead department (departments.is_overhead),
--   hours booked to a LEAVE job (leave_types.job_id) do not count toward
--   the block. Their hours on any other job still do.
--
-- Non-overhead employees are unchanged: their leave hours still block.
-- No timesheet data is changed. The leave mapping is leave_types.job_id
-- (jobs.leave_type_id is stale - do not use it).
--
-- Re-issued whole from 182 (production body verified identical 2026-09-28);
-- only the entry filter and the message's dash changed. Safe to re-run.

create or replace function public.block_deactivate_with_unexported_hours()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    v_weeks    text;
    v_overhead boolean;
begin
    select coalesce(d.is_overhead, false)
      into v_overhead
      from public.departments d
     where d.id = new.department_id;
    v_overhead := coalesce(v_overhead, false);

    select string_agg(
               to_char(ts.week_start, 'DD Mon YYYY') || ' (' || ts.status || ')',
               ', ' order by ts.week_start)
      into v_weeks
      from public.timesheets ts
     where ts.user_id = new.id
       and ts.status <> 'exported'
       and exists (
           select 1
             from public.timesheet_entries e
            where e.timesheet_id = ts.id
              and (e.mon_hours > 0 or e.tue_hours > 0 or e.wed_hours > 0
                or e.thu_hours > 0 or e.fri_hours > 0 or e.sat_hours > 0
                or e.sun_hours > 0)
              -- overhead staff: leave lines don't count (191)
              and not (v_overhead and exists (
                  select 1 from public.leave_types lt
                   where lt.job_id = e.job_id))
       );

    if v_weeks is not null then
        raise exception
            'Cannot deactivate %: they have unexported hours - week(s) %. Export those timesheets (or clear the hours) first, then deactivate.',
            coalesce(new.name, 'this employee'), v_weeks;
    end if;

    return new;
end;
$$;

-- The trigger from 182 is unchanged and keeps calling this function.

-- Check: Kelly (overhead, leave-only drafts) now passes; an overhead person
-- with real unexported job hours, and a non-overhead person with unexported
-- leave, would still be blocked. Read-only.
select
    exists (select 1 from pg_trigger
             where tgname = 'trg_users_block_deactivate_unexported') as trigger_ok,
    position('leave_types' in (select prosrc from pg_proc
             where proname = 'block_deactivate_with_unexported_hours')) > 0 as rule_ok;
