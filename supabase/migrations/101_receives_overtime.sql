-- 101_receives_overtime.sql
--
-- Adds public.users.receives_overtime: per-employee toggle that gates
-- whether their hours show up on the overtime portion of the leave /
-- overtime report.
--
-- Defaults to true so existing employees behave exactly as before -
-- they keep accruing overtime in the report. Admins flip it false on
-- employees who are paid salary-with-no-OT, contractors on fixed fees,
-- etc. The exclusion is purely a reporting concern; the raw hours are
-- still stored, the employee can still log them, the timesheet still
-- approves them. The report just skips them when summing overtime.
--
-- Idempotent.

alter table public.users
    add column if not exists receives_overtime boolean not null default true;
