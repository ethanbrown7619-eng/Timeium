-- 034_deadline_and_notifications.sql
-- Adds timesheet deadline and email notification settings to organisations.
--
-- Safe to re-run.

-- Deadline: which week the timesheet is due, which day, what time
alter table public.organisations
    add column if not exists deadline_week text not null default 'following_week'
        check (deadline_week in ('this_week', 'following_week'));

alter table public.organisations
    add column if not exists deadline_day text not null default 'monday'
        check (deadline_day in ('monday','tuesday','wednesday','thursday','friday','saturday','sunday'));

alter table public.organisations
    add column if not exists deadline_time time not null default '08:00';

-- Email notifications
alter table public.organisations
    add column if not exists notify_overdue boolean not null default false;

alter table public.organisations
    add column if not exists notify_reminder boolean not null default false;

alter table public.organisations
    add column if not exists reminder_day text not null default 'friday'
        check (reminder_day in ('monday','tuesday','wednesday','thursday','friday','saturday','sunday'));

alter table public.organisations
    add column if not exists reminder_time time not null default '09:00';
