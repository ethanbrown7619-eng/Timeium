-- 025_staff_management.sql
-- Temporium Unit 2 — staff management.
--
-- Adds:
--   users.department_id             — FK to departments, co-exists with the
--                                     free-text department column until a
--                                     future migration drops the text column
--   departments.manager_id          — FK to users (the department's manager)
--   create_employee(...)            — RPC that auto-generates a 32-hex qr_token
--                                     and resolves the org via resolve_org_id
--
-- Relies on Attendium's users RLS allowing is_admin_of(organisation_id) to
-- INSERT / UPDATE / DELETE user rows. If that isn't in place, we will add a
-- dedicated update_employee RPC in a follow-up migration.
--
-- Safe to re-run.

--------------------------------------------------------------------------------
-- pgcrypto (for gen_random_bytes) — Attendium almost certainly already has
-- this; IF NOT EXISTS makes it idempotent.
--------------------------------------------------------------------------------

create extension if not exists pgcrypto;

--------------------------------------------------------------------------------
-- users.department_id
--------------------------------------------------------------------------------

alter table public.users
    add column if not exists department_id bigint
        references public.departments (id) on delete set null;

create index if not exists users_department_id_idx on public.users (department_id);

-- Backfill: link each user whose free-text department matches a department
-- name in the same organisation. Case- and whitespace-insensitive. Runs once;
-- a repeat application is a no-op because the WHERE clause excludes already-
-- linked rows.
update public.users u
    set department_id = d.id
    from public.departments d
    where d.organisation_id = u.organisation_id
      and u.department is not null
      and trim(u.department) <> ''
      and lower(trim(d.name)) = lower(trim(u.department))
      and u.department_id is null;

--------------------------------------------------------------------------------
-- departments.manager_id
-- ON DELETE SET NULL so deactivating/deleting a manager doesn't cascade-
-- delete the department.
--------------------------------------------------------------------------------

alter table public.departments
    add column if not exists manager_id bigint
        references public.users (id) on delete set null;

create index if not exists departments_manager_id_idx on public.departments (manager_id);

--------------------------------------------------------------------------------
-- create_employee RPC
--
-- Auto-generates a 32-hex qr_token so that if Attendium is later installed,
-- the kiosk recognises the employee immediately. Other fields are optional
-- and default-friendly. Profile "complete" per Unit 2 rules requires:
--   department_id, cost_rate, sell_rate, employment_type, employee_code
-- The RPC does NOT enforce completeness — the UI flags incomplete profiles.
--------------------------------------------------------------------------------

create or replace function public.create_employee(
    p_org_id                   bigint  default null,
    p_name                     text    default null,
    p_email                    text    default null,
    p_department_id            bigint  default null,
    p_cost_rate                numeric default null,
    p_sell_rate                numeric default null,
    p_employment_type          text    default 'waged',
    p_employee_code            text    default null,
    p_overtime_threshold_hours numeric default null
)
returns public.users
language plpgsql security definer set search_path = public
as $$
declare
    v_org  bigint;
    v_user public.users;
begin
    v_org := public.resolve_org_id(p_org_id);

    if p_name is null or trim(p_name) = '' then
        raise exception 'Name is required';
    end if;

    if p_employment_type is not null
       and p_employment_type not in ('waged', 'salaried', 'contractor') then
        raise exception 'employment_type must be one of: waged, salaried, contractor';
    end if;

    insert into public.users (
        organisation_id, name, email, department_id,
        cost_rate, sell_rate, employment_type, employee_code,
        overtime_threshold_hours, qr_token, active
    )
    values (
        v_org,
        trim(p_name),
        nullif(trim(coalesce(p_email, '')), ''),
        p_department_id,
        p_cost_rate,
        p_sell_rate,
        coalesce(p_employment_type, 'waged'),
        nullif(trim(coalesce(p_employee_code, '')), ''),
        coalesce(p_overtime_threshold_hours, 40.0),
        encode(gen_random_bytes(16), 'hex'),
        true
    )
    returning * into v_user;

    return v_user;
end$$;

grant execute on function public.create_employee(
    bigint, text, text, bigint, numeric, numeric, text, text, numeric
) to authenticated;
