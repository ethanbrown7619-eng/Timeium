-- 164_module_access.sql
-- Per-department access to the PTL ERP modules, administered from the
-- Timesheet Configure tab, plus the registry that drives every app's
-- module switcher.
--
--------------------------------------------------------------------------------
-- WHY THE MODULE LIST LIVES IN THE DATABASE
--------------------------------------------------------------------------------
-- Today each repo carries its own hand-maintained copy of the module
-- directory in public/js/erp-apps.js, and they have already drifted:
--
--   partsmaster (the declared canonical copy) ... 6 modules
--   PTL-workshop ............................... 6
--   ptl-purchase-orders ........................ 7  (added itself)
--   PTL-spares ................................. 8  (added itself + purchase orders)
--   PTL Timesheet .............................. absent from all of them
--
-- Each app added itself locally rather than updating the hub, and
-- partsmaster/scripts/sync-tokens.mjs only pushes to four siblings resolved
-- as ../<repo>, which cannot reach this repo at all (it lives under
-- C:\erp\time, not C:\erp\parts).
--
-- public.erp_modules replaces that as the source of truth: adding a module
-- becomes one row instead of nine commits, and the switcher and the access
-- matrix read the same list by construction. erp-apps.js stays in each repo
-- only as a bootstrap fallback for a cold start.
--
--------------------------------------------------------------------------------
-- ACCESS MODEL
--------------------------------------------------------------------------------
--   * DENY BY DEFAULT. A department with no grants sees only the modules
--     flagged always_granted. Matches the decision taken for the Purchase
--     Orders tab matrix (its migration 041).
--   * Developers and org admins see every active module.
--   * Timesheet is always_granted and cannot be revoked — everyone is
--     required to file a timesheet, so removing it would lock staff out of a
--     mandatory task.
--   * Only DEVELOPERS may edit the matrix (is_developer()), matching how the
--     Purchase Orders matrix is gated. Org admins can see it but not change
--     it — cross-module access is a wider blast radius than ordinary org
--     configuration.
--
--------------------------------------------------------------------------------
-- WHAT THIS DOES AND DOES NOT ENFORCE
--------------------------------------------------------------------------------
-- module_access_granted() is the predicate each module calls on load to
-- refuse entry (Phase 2). Understand precisely what that buys:
--
--   * It is a LOCKOUT, not a data boundary. It stops a user opening a module
--     they were not granted.
--   * It does NOT, on its own, stop a determined signed-in user calling that
--     module's RPCs or tables directly with the public anon key. Each
--     module's own RLS still governs its data, exactly as before — this
--     changes nothing about that and must not be mistaken for it.
--
-- For a module where module access is meant to be a genuine data boundary,
-- fold module_access_granted('<key>') into that module's RLS policies. The
-- predicate is written to be safe in a policy: STABLE, SECURITY DEFINER, and
-- it never raises.
--
-- This is the same distinction the Purchase Orders matrix documents about
-- itself, and the same one the August 2026 security audit turned on: the UI
-- is not a security control.
--
-- Safe to re-run.

--------------------------------------------------------------------------------
-- 1. Module registry
--------------------------------------------------------------------------------

create table if not exists public.erp_modules (
    key            text primary key,
    name           text        not null,
    href           text        not null,
    description    text,
    sort_order     integer     not null default 100,
    active         boolean     not null default true,
    -- Cannot be revoked from any department. Timesheet only, for now.
    always_granted boolean     not null default false,
    updated_at     timestamptz not null default now()
);

-- Seeded from the union of every repo's erp-apps.js, plus Timesheet.
-- ON CONFLICT DO NOTHING so an operator who renames a module or corrects a
-- URL in the registry is not overwritten by a re-run — the table is the
-- source of truth from here on, not this file.
insert into public.erp_modules (key, name, href, description, sort_order, always_granted) values
    ('timesheet',      'Timesheet',       'https://temporium.ethanbrown7619.workers.dev',        'Timesheets, leave & payroll',  10, true),
    ('partsmaster',    'PartsMaster',     'https://partsmaster.ethanbrown7619.workers.dev',      'Part identity registry',       20, false),
    ('bom-import',     'BOM Import',      'https://ptl-bom-import.ethanbrown7619.workers.dev',   'Engineering BOMs',             30, false),
    ('procure',        'Procure',         'https://ptl-procure1.ethanbrown7619.workers.dev',     'Purchasing & POs',             40, false),
    ('purchaseorders', 'Purchase Orders', 'https://ptl-purchaseorders.ethanbrown7619.workers.dev','Infusion PO tracking',        50, false),
    ('stock',          'Stock',           'https://ptl-stock-keeper.ethanbrown7619.workers.dev', 'Shop-floor stock',             60, false),
    ('partslogistics', 'PartsLogistics',  'https://ptl-partslogistics.ethanbrown7619.workers.dev','Goods inwards & QA',          70, false),
    ('spares',         'Spares',          'https://ptl-spares.ethanbrown7619.workers.dev',       'Spares & consumables',         80, false),
    ('map',            'Factory Map',     'https://ptl-map.ethanbrown7619.workers.dev',          'Floor plan & shelves',         90, false)
on conflict (key) do nothing;

alter table public.erp_modules enable row level security;

-- No direct client access at all: the switcher and the matrix both go
-- through SECURITY DEFINER RPCs below, so ordinary users never need a SELECT
-- grant on the registry.
revoke all on public.erp_modules from anon, authenticated;
grant all on public.erp_modules to service_role;

drop policy if exists "developers manage erp_modules" on public.erp_modules;
create policy "developers manage erp_modules"
    on public.erp_modules for all
    to authenticated
    using (public.is_developer())
    with check (public.is_developer());

--------------------------------------------------------------------------------
-- 2. Grants: department -> module
--------------------------------------------------------------------------------

create table if not exists public.dept_module_access (
    id              bigserial primary key,
    organisation_id bigint not null references public.organisations (id) on delete cascade,
    department_id   bigint not null references public.departments   (id) on delete cascade,
    module_key      text   not null references public.erp_modules   (key) on delete cascade,
    created_at      timestamptz not null default now(),
    unique (organisation_id, department_id, module_key)
);

create index if not exists dept_module_access_dept_idx
    on public.dept_module_access (organisation_id, department_id);

alter table public.dept_module_access enable row level security;

revoke all on public.dept_module_access from anon, authenticated;
grant all on public.dept_module_access to service_role;

drop policy if exists "developers manage dept_module_access" on public.dept_module_access;
create policy "developers manage dept_module_access"
    on public.dept_module_access for all
    to authenticated
    using (public.is_developer())
    with check (public.is_developer());

--------------------------------------------------------------------------------
-- 3. _caller_org — the caller's organisation, without requiring an admins row
--
-- resolve_org_id() raises 'not an admin' for ordinary employees, so it cannot
-- be used by the reader functions below, which every signed-in user calls.
--------------------------------------------------------------------------------

create or replace function public._caller_org_id()
returns bigint
language plpgsql stable security definer set search_path = public
as $$
declare v_org bigint;
begin
    select u.organisation_id into v_org
      from public.users u where u.auth_user_id = auth.uid() limit 1;
    if v_org is null then
        select a.organisation_id into v_org
          from public.admins a where a.user_id = auth.uid() limit 1;
    end if;
    return v_org;
end$$;

revoke all on function public._caller_org_id() from public, anon, authenticated;

--------------------------------------------------------------------------------
-- 4. my_allowed_modules — drives the switcher in every app
--
-- Returns registry rows, so one call gives the client everything it needs to
-- render the menu. Never raises: a switcher must not be able to break a page.
--------------------------------------------------------------------------------

create or replace function public.my_allowed_modules()
returns table (
    key         text,
    name        text,
    href        text,
    description text,
    sort_order  integer
)
language plpgsql stable security definer set search_path = public
as $$
declare
    v_org bigint;
    v_all boolean;
begin
    if auth.uid() is null then
        return;
    end if;

    v_org := public._caller_org_id();
    v_all := public.is_developer() or (v_org is not null and public.is_admin_of(v_org));

    return query
    select m.key, m.name, m.href, m.description, m.sort_order
      from public.erp_modules m
     where m.active
       and (
             v_all                                    -- developers + org admins
          or m.always_granted                         -- Timesheet
          or (v_org is not null and exists (
                select 1
                  from public.dept_module_access a
                  join public.users u
                    on u.department_id   = a.department_id
                   and u.auth_user_id    = auth.uid()
                 where a.module_key      = m.key
                   and a.organisation_id = v_org))
       )
     order by m.sort_order, m.name;
end$$;

revoke all on function public.my_allowed_modules() from public, anon;
grant execute on function public.my_allowed_modules() to authenticated;

--------------------------------------------------------------------------------
-- 5. module_access_granted — the per-module entry predicate (Phase 2)
--
-- Deliberately never raises and returns false on any uncertainty, so a module
-- that calls it fails CLOSED. Safe to use inside an RLS policy.
--------------------------------------------------------------------------------

create or replace function public.module_access_granted(p_module_key text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
    v_org bigint;
begin
    if auth.uid() is null or p_module_key is null then
        return false;
    end if;

    if exists (select 1 from public.erp_modules m
                where m.key = p_module_key and m.always_granted and m.active) then
        return true;
    end if;

    if public.is_developer() then
        return true;
    end if;

    v_org := public._caller_org_id();
    if v_org is null then
        return false;
    end if;
    if public.is_admin_of(v_org) then
        return true;
    end if;

    return exists (
        select 1
          from public.dept_module_access a
          join public.users u
            on u.department_id   = a.department_id
           and u.auth_user_id    = auth.uid()
          join public.erp_modules m
            on m.key = a.module_key and m.active
         where a.module_key      = p_module_key
           and a.organisation_id = v_org);
end$$;

revoke all on function public.module_access_granted(text) from public, anon;
grant execute on function public.module_access_granted(text) to authenticated;

--------------------------------------------------------------------------------
-- 6. list_module_access_matrix — the Configure grid (developers only)
--------------------------------------------------------------------------------

create or replace function public.list_module_access_matrix(p_org_id bigint default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
    v_org bigint;
begin
    if not public.is_developer() then
        return jsonb_build_object('is_developer', false);
    end if;
    v_org := public.resolve_org_id(p_org_id);
    if v_org is null then
        raise exception 'organisation id is required';
    end if;

    return jsonb_build_object(
        'is_developer', true,
        'organisation_id', v_org,
        'modules', coalesce((
            select jsonb_agg(jsonb_build_object(
                     'key', m.key, 'name', m.name, 'description', m.description,
                     'always_granted', m.always_granted)
                   order by m.sort_order, m.name)
              from public.erp_modules m where m.active), '[]'::jsonb),
        'departments', coalesce((
            select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name)
                   order by lower(d.name))
              from public.departments d
             where d.organisation_id = v_org and coalesce(d.active, true)), '[]'::jsonb),
        'grants', coalesce((
            select jsonb_agg(jsonb_build_object(
                     'department_id', a.department_id, 'module_key', a.module_key))
              from public.dept_module_access a
             where a.organisation_id = v_org), '[]'::jsonb));
end$$;

revoke all on function public.list_module_access_matrix(bigint) from public, anon;
grant execute on function public.list_module_access_matrix(bigint) to authenticated;

--------------------------------------------------------------------------------
-- 7. set_dept_module_access — one checkbox toggle (developers only)
--------------------------------------------------------------------------------

create or replace function public.set_dept_module_access(
    p_department_id bigint,
    p_module_key    text,
    p_allowed       boolean,
    p_org_id        bigint default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    v_org bigint;
    v_always boolean;
begin
    if not public.is_developer() then
        raise exception 'not authorised';
    end if;
    v_org := public.resolve_org_id(p_org_id);
    if v_org is null then
        raise exception 'organisation id is required';
    end if;

    select m.always_granted into v_always
      from public.erp_modules m where m.key = p_module_key;
    if v_always is null then
        raise exception 'unknown module: %', p_module_key;
    end if;
    if v_always then
        raise exception '% is available to everyone and cannot be restricted', p_module_key;
    end if;

    -- The department must belong to the resolved org: never let a developer
    -- grant one org's department access via another org's id.
    if not exists (select 1 from public.departments d
                    where d.id = p_department_id and d.organisation_id = v_org) then
        raise exception 'department % is not in organisation %', p_department_id, v_org;
    end if;

    if p_allowed then
        insert into public.dept_module_access (organisation_id, department_id, module_key)
        values (v_org, p_department_id, p_module_key)
        on conflict (organisation_id, department_id, module_key) do nothing;
    else
        delete from public.dept_module_access
         where organisation_id = v_org
           and department_id   = p_department_id
           and module_key      = p_module_key;
    end if;
end$$;

revoke all on function public.set_dept_module_access(bigint, text, boolean, bigint) from public, anon;
grant execute on function public.set_dept_module_access(bigint, text, boolean, bigint) to authenticated;

notify pgrst, 'reload schema';

--------------------------------------------------------------------------------
-- VERIFICATION
--
-- 1. Registry seeded (expect 9 rows, timesheet always_granted = true):
--      select key, name, sort_order, always_granted from public.erp_modules
--       order by sort_order;
--
-- 2. As a PLAIN EMPLOYEE whose department has no grants — expect exactly one
--    row, 'timesheet':
--      await sb.rpc("my_allowed_modules");
--
-- 3. As a DEVELOPER — expect all 9, and the matrix payload:
--      await sb.rpc("my_allowed_modules");
--      await sb.rpc("list_module_access_matrix", { p_org_id: 1 });
--
-- 4. Grant one module, then re-check the employee sees two rows:
--      select public.set_dept_module_access(<dept_id>, 'map', true, 1);
--
-- 5. Timesheet cannot be revoked — expect an exception:
--      select public.set_dept_module_access(<dept_id>, 'timesheet', false, 1);
--
-- 6. As a NON-developer admin — matrix must refuse, switcher must still work:
--      await sb.rpc("list_module_access_matrix", { p_org_id: 1 });  // is_developer:false
--      await sb.rpc("my_allowed_modules");                          // all modules
--------------------------------------------------------------------------------
