-- 046_autofill_public_holidays.sql
-- Org setting to auto-fill public holidays on employee timesheets.
-- When enabled, get_or_create_timesheet checks for public holidays
-- that week and adds entries automatically.
-- Safe to re-run.

alter table public.organisations
    add column if not exists autofill_public_holidays boolean not null default false;

alter table public.organisations
    add column if not exists public_holiday_hours numeric(4,2) not null default 8.0;
