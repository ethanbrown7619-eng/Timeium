-- 028_employee_code_optional_unique.sql
-- Temporium — employee code is optional for profile completeness but must
-- be unique within each organisation when set.
--
-- Attendium's original schema has a global UNIQUE on users.employee_code.
-- Multi-tenant orgs need per-org uniqueness instead: two employees in
-- different orgs can share the same code, but no two employees in the
-- SAME org can.
--
-- Safe to re-run.

-- Drop the old global unique constraint if Attendium created one.
-- The constraint name varies depending on how it was defined; try the
-- most common auto-generated name.
do $$
begin
    if exists (
        select 1 from pg_constraint
        where conname = 'users_employee_code_key'
          and conrelid = 'public.users'::regclass
    ) then
        alter table public.users drop constraint users_employee_code_key;
    end if;
end$$;

-- Also drop the index form if it was created as a standalone index.
drop index if exists public.users_employee_code_key;

-- Per-org unique partial index — only enforced when employee_code is not null,
-- so multiple employees can have NULL codes without conflict.
create unique index if not exists users_org_employee_code_uniq
    on public.users (organisation_id, employee_code)
    where employee_code is not null;
