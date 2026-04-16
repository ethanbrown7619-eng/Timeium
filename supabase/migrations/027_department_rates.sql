-- 027_department_rates.sql
-- Temporium — per-department cost/sell rates.
--
-- Departments now carry default cost_rate and sell_rate. Employees inherit
-- these unless they have a specific override set on their own row.
--
-- Safe to re-run.

alter table public.departments
    add column if not exists cost_rate numeric(10, 2),
    add column if not exists sell_rate numeric(10, 2);
