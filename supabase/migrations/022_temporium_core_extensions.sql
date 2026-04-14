-- 022_temporium_core_extensions.sql
-- First Temporium migration. Extends the shared core (owned by Attendium,
-- migrations 001–021) with the columns, helpers, and role values that
-- Temporium-specific features need.
--
-- Safe to re-run. Safe for Attendium: widening the admins_role_check and
-- adding helpers / columns doesn't change any existing behaviour.
--
-- Shared-core assumption:
--   public.organisations       already exists
--   public.users               already exists (with employee_code, cost_rate,
--                              sell_rate, department, email, organisation_id)
--   public.admins              already exists (role text check (role in
--                              ('admin','developer')))
--   public.is_admin()          already exists
--   public.is_admin_of(bigint) already exists
--   public.is_developer()      already exists
--   public.resolve_org_id(bigint) already exists
--
-- Everything we add here is idempotent.

--------------------------------------------------------------------------------
-- users: add the columns Temporium needs for approval routing and employee login
--------------------------------------------------------------------------------

alter table public.users
    add column if not exists manager_id bigint
        references public.users (id) on delete set null,
    add column if not exists auth_user_id uuid
        references auth.users (id) on delete set null,
    add column if not exists employment_type text
        check (employment_type in ('waged', 'salaried', 'contractor'))
        default 'waged',
    add column if not exists overtime_threshold_hours numeric(5, 2)
        default 40.0;

-- Case-insensitive unique auth linkage (null-friendly).
do $$
begin
    if not exists (
        select 1 from pg_indexes
        where schemaname = 'public'
          and indexname  = 'users_auth_user_id_key'
    ) then
        create unique index users_auth_user_id_key
            on public.users (auth_user_id)
            where auth_user_id is not null;
    end if;
end$$;

create index if not exists users_manager_id_idx on public.users (manager_id);

--------------------------------------------------------------------------------
-- admins.role: widen to include 'manager'
--   Attendium's current check is (role in ('admin','developer')). Drop by
--   name if present; re-add with the wider set. If the constraint uses a
--   different name, the later ADD CONSTRAINT will still succeed — the two
--   constraints would cooperate (AND semantics).
--------------------------------------------------------------------------------

do $$
begin
    if exists (
        select 1 from pg_constraint
        where conname = 'admins_role_check'
          and conrelid = 'public.admins'::regclass
    ) then
        alter table public.admins drop constraint admins_role_check;
    end if;
end$$;

alter table public.admins
    add constraint admins_role_check
    check (role in ('admin', 'manager', 'developer'));

--------------------------------------------------------------------------------
-- is_manager_of(org)
--   Returns true if the caller is a developer, or an admin of `org`, or a
--   manager of `org`. Used by Temporium RLS policies on approval-scoped tables.
--------------------------------------------------------------------------------

create or replace function public.is_manager_of(org_id bigint)
returns boolean
language sql stable security definer set search_path = public
as $$
    select exists (
        select 1 from public.admins
        where admins.user_id = auth.uid()
          and (
              admins.role = 'developer'
              or (admins.organisation_id = org_id
                  and admins.role in ('admin', 'manager'))
          )
    );
$$;

grant execute on function public.is_manager_of(bigint) to authenticated;

--------------------------------------------------------------------------------
-- current_user_employee()
--   Resolves the calling auth.uid() to a public.users row id. Used by
--   employee-facing RPCs in later units (save_timesheet_draft etc.) and by
--   the "members read" RLS policies on departments/projects.
--------------------------------------------------------------------------------

create or replace function public.current_user_employee()
returns bigint
language sql stable security definer set search_path = public
as $$
    select u.id from public.users u where u.auth_user_id = auth.uid() limit 1;
$$;

grant execute on function public.current_user_employee() to authenticated;
