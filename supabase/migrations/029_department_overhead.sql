-- 029_department_overhead.sql
-- Temporium — overhead departments.
--
-- Overhead departments (admin, management, HR, etc.) don't have billable
-- cost/sell rates. Marking a department as overhead sets rates to N/A in
-- the UI and exempts its employees from the "missing rate" incomplete-
-- profile check.
--
-- Safe to re-run.

alter table public.departments
    add column if not exists is_overhead boolean not null default false;
