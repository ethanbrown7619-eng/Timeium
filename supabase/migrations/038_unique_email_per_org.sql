-- 038_unique_email_per_org.sql
-- Enforce unique email per organisation (same pattern as employee_code).
-- Partial index so NULL emails are allowed (not every employee has one).
--
-- Safe to re-run.

create unique index if not exists users_org_email_uniq
    on public.users (organisation_id, lower(email))
    where email is not null;
