-- 039_test_staff_flag.sql
-- Developer-only flag to mark test employees for easy bulk deletion.
-- Safe to re-run.

alter table public.users
    add column if not exists is_test boolean not null default false;
