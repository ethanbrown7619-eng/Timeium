-- 182_block_deactivation_with_unexported_hours.sql
-- Deactivating an employee must not strand payroll hours.
--
-- The incident (2026-09-01): an employee was deactivated before the
-- week's Infusion export ran, and their hours never reached payroll.
-- The export builds its rows from the active-employee list
-- (fetchWeekDashboardData filters active = true, and buildInfusionRows
-- skips any entry whose user isn't in that list) — so a deactivated
-- user's approved timesheet is silently dropped from the export.
--
-- The fix is at the database, not the client: deactivation is a plain
-- PostgREST update of users.active from staff.js, so a BEFORE UPDATE
-- trigger is the only gate every path goes through (the staff page, the
-- SQL editor, anything else). The rule:
--
--   users.active may not flip true -> false while the user has ANY
--   timesheet that is not yet 'exported' and carries hours ( > 0 on any
--   day of any entry).
--
-- Deliberately broader than "a draft this week": submitted, approved and
-- rejected hours haven't reached payroll either, and the actual incident
-- was almost certainly approved-but-not-yet-exported. Deliberately
-- narrower than "any timesheet": a ZERO-hour draft never blocks —
-- admin_get_or_create_timesheet (110) creates empty drafts, and blocking
-- on those would make deactivation randomly impossible.
--
-- Consequence worth knowing: a future-week draft pre-populated with
-- approved leave (populate_timesheet_for_leave) also blocks — clear or
-- export it first. That is the correct behaviour for a departing
-- employee: those hours are real payroll rows.
--
-- The error message lists the offending week(s); staff.js already
-- surfaces error.message via notice(), so no client change is needed.
--
-- SECURITY DEFINER so the EXISTS check sees ALL the user's timesheets,
-- not just those the caller's RLS view allows.
--
-- Safe to re-run.

create or replace function public.block_deactivate_with_unexported_hours()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    v_weeks text;
begin
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
       );

    if v_weeks is not null then
        raise exception
            'Cannot deactivate %: they have unexported hours — week(s) %. Export those timesheets (or clear the hours) first, then deactivate.',
            coalesce(new.name, 'this employee'), v_weeks;
    end if;

    return new;
end;
$$;

drop trigger if exists trg_users_block_deactivate_unexported on public.users;
create trigger trg_users_block_deactivate_unexported
    before update of active on public.users
    for each row
    when (coalesce(old.active, true) and new.active = false)
    execute function public.block_deactivate_with_unexported_hours();
