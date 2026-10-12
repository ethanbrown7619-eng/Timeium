-- 193_every_line_needs_a_job.sql
-- Company rule (user, 2026-10-13): "no matter who is submitting the
-- timesheet every line needs a job".
--
-- The case: Sam Bonnici, week of 5 Oct 2026. Sam submitted with a job on
-- every line (the row's job_status_snapshot is ACTIVE, which submission
-- only writes from a real job). On Mon 12 Oct 08:35 NZT someone edited the
-- sheet in Admin edit mode, re-pointed two rows to 11225800, and CLEARED the
-- job on "Cleaning for FAT" (2h) without picking a new one - clearing the
-- job box saves immediately. The sheet was exported to Infusion that
-- afternoon with a blank jobid line. Only the employee submit screen checked
-- for a job; admin edit, admin submit and the export did not, and the
-- database allowed it.
--
-- Two triggers, same shape as 148 (department on submit):
--
--   1. On the STATUS change to submitted / approved / exported: refused
--      while any line with hours has no job. Approve and export are covered
--      too, not just submit, because the admin path can edit a sheet after
--      it was submitted.
--   2. On a LINE of a submitted / approved / exported sheet: a line with
--      hours cannot lose its job, and hours cannot be typed onto a line
--      that has none. This is what stops the admin-edit case above at the
--      moment it happens rather than at export.
--
-- Zero-hour lines are exempt in the database (empty filler; Admin edit's
-- "add row" creates one before the job is picked, and nothing with zero
-- hours reaches the export). The employee submit screen still requires a
-- job on EVERY line, zero-hour ones included.
--
-- Draft and rejected sheets are untouched - that is where people are still
-- filling them in.
--
-- Existing rows are not rewritten. The three old exported lines with hours
-- and no job (incl. Sam's) stay as they are until someone picks a job,
-- which trigger 2 allows (setting a job is always fine; so is editing a
-- jobless line's description).
--
-- SECURITY DEFINER on both so the lookups see the rows whatever the caller's
-- RLS - an invoker lookup that RLS hid would silently skip the check.
--
-- Safe to re-run. ASCII only.

create or replace function public.check_timesheet_jobs_on_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_missing integer;
    v_list    text;
begin
    if new.status in ('submitted', 'approved', 'exported')
       and old.status is distinct from new.status then
        select count(*),
               string_agg(coalesce(nullif(trim(e.description), ''), '(no description)'), ', '
                          order by e.sort_order, e.id)
          into v_missing, v_list
          from public.timesheet_entries e
         where e.timesheet_id = new.id
           and e.job_id is null
           and (coalesce(e.mon_hours, 0) + coalesce(e.tue_hours, 0) + coalesce(e.wed_hours, 0)
              + coalesce(e.thu_hours, 0) + coalesce(e.fri_hours, 0) + coalesce(e.sat_hours, 0)
              + coalesce(e.sun_hours, 0)) > 0;

        if v_missing > 0 then
            raise exception 'Every line needs a job: % line(s) with hours have no job (%)', v_missing, v_list
                using errcode = 'check_violation';
        end if;
    end if;
    return new;
end$$;

drop trigger if exists trg_timesheet_require_jobs on public.timesheets;
create trigger trg_timesheet_require_jobs
    before update of status on public.timesheets
    for each row execute function public.check_timesheet_jobs_on_status();


create or replace function public.check_timesheet_entry_has_job()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_hours  numeric;
    v_status text;
begin
    if new.job_id is not null then
        return new;
    end if;

    v_hours := coalesce(new.mon_hours, 0) + coalesce(new.tue_hours, 0) + coalesce(new.wed_hours, 0)
             + coalesce(new.thu_hours, 0) + coalesce(new.fri_hours, 0) + coalesce(new.sat_hours, 0)
             + coalesce(new.sun_hours, 0);
    if v_hours = 0 then
        return new;
    end if;

    -- An old jobless line may still have its description edited; only
    -- removing a job or adding hours to a jobless line is refused.
    if tg_op = 'UPDATE'
       and old.job_id is null
       and (new.mon_hours, new.tue_hours, new.wed_hours, new.thu_hours,
            new.fri_hours, new.sat_hours, new.sun_hours)
           is not distinct from
           (old.mon_hours, old.tue_hours, old.wed_hours, old.thu_hours,
            old.fri_hours, old.sat_hours, old.sun_hours) then
        return new;
    end if;

    select t.status into v_status from public.timesheets t where t.id = new.timesheet_id;
    if v_status in ('submitted', 'approved', 'exported') then
        raise exception 'Every line needs a job: pick the job for this line first (it has %h and the timesheet is %)',
            trim_scale(v_hours), v_status
            using errcode = 'check_violation';
    end if;
    return new;
end$$;

drop trigger if exists trg_timesheet_entry_require_job on public.timesheet_entries;
create trigger trg_timesheet_entry_require_job
    before insert or update on public.timesheet_entries
    for each row execute function public.check_timesheet_entry_has_job();

-- Trigger functions only; nobody calls them directly.
revoke all on function public.check_timesheet_jobs_on_status()  from public, anon, authenticated;
revoke all on function public.check_timesheet_entry_has_job()   from public, anon, authenticated;
