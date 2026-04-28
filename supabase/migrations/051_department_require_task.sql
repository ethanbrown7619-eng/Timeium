-- 051_department_require_task.sql
-- Add option for departments to require the task field on timesheets.

alter table public.departments
    add column if not exists require_task boolean not null default false;
