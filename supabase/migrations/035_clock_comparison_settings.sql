-- 035_clock_comparison_settings.sql
-- Adds clock-vs-timesheet tolerance and discrepancy notification settings.
--
-- Safe to re-run.

alter table public.organisations
    add column if not exists clock_tolerance_hours numeric(4,2) not null default 0.5;

alter table public.organisations
    add column if not exists notify_discrepancy boolean not null default false;

alter table public.organisations
    add column if not exists discrepancy_day text not null default 'monday'
        check (discrepancy_day in ('monday','tuesday','wednesday','thursday','friday','saturday','sunday'));

alter table public.organisations
    add column if not exists discrepancy_time time not null default '10:00';
