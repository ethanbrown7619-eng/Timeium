-- 177_user_module_access.sql
--
-- Per-EMPLOYEE module access, alongside the per-department grants of
-- migration 164. Administered from the same Configure > Module Access tab:
-- pick a person, tick the modules they may open.
--
--------------------------------------------------------------------------------
-- WHY, AND WHAT IT IS NOT
--------------------------------------------------------------------------------
-- Departments are the right default and stay the primary mechanism. But the
-- exceptions are real and permanent: the one person in Production who also
-- raises purchase orders, the office manager who needs the Factory Map. Today
-- the only way to serve them is to grant their whole department the module,
-- which is a much wider grant than anybody intended.
--
-- ADDITIVE ONLY. A per-user grant ADDS to whatever the person's department
-- already has. It cannot take a module away from somebody whose department is
-- granted it — for that, the department grant is the thing to change. This is
-- deliberate: a deny-override needs a precedence rule and a tri-state UI, and
-- the requirement here ("select an employee and give them specific module
-- access") is purely additive. If per-person revocation is ever wanted, it
-- wants its own migration and its own thinking, not a boolean bolted onto
-- this table.
--
-- The lockout/data-boundary caveat from 164 applies unchanged and is worth
-- re-reading: module_access_granted() stops a user OPENING a module. It is not
-- a substitute for that module's own RLS.
--
--------------------------------------------------------------------------------
-- WHO MAY EDIT
--------------------------------------------------------------------------------
-- Developers only, exactly as 164 set it for departments. Org admins can see
-- the grid and not change it. Cross-module access has a wider blast radius
-- than ordinary org configuration.
--
--------------------------------------------------------------------------------
-- WHAT THE READER FUNCTIONS ARE BUILT FROM
--------------------------------------------------------------------------------
-- my_allowed_modules() and module_access_granted() below are migration 166's
-- bodies verbatim, plus one OR arm each. 166 — NOT 164 — is what is live: it
-- carries the 2026-08-06 audit fixes (F1 deactivated departments, F2
-- deactivated staff, F4 fail-closed exception handler). Rebuilding from 164
-- would silently revert all three.
--
-- Neither function's return type changes, so CREATE OR REPLACE is enough and
-- the existing grants survive. No DROP anywhere in this file.
--
-- Safe to re-run.


--------------------------------------------------------------------------------
-- 1. Grants: user -> module
--------------------------------------------------------------------------------

create table if not exists public.user_module_access (
    id              bigserial primary key,
    organisation_id bigint not null references public.organisations (id) on delete cascade,
    user_id         bigint not null references public.users         (id) on delete cascade,
    module_key      text   not null references public.erp_modules   (key) on delete cascade,
    created_at      timestamptz not null default now(),
    unique (organisation_id, user_id, module_key)
);

create index if not exists user_module_access_user_idx
    on public.user_module_access (organisation_id, user_id);

alter table public.user_module_access enable row level security;

-- No direct client access: everything goes through the SECURITY DEFINER RPCs
-- below, matching dept_module_access.
revoke all on public.user_module_access from anon, authenticated;
grant all on public.user_module_access to service_role;

drop policy if exists "developers manage user_module_access" on public.user_module_access;
create policy "developers manage user_module_access"
    on public.user_module_access for all
    to authenticated
    using (public.is_developer())
    with check (public.is_developer());


--------------------------------------------------------------------------------
-- 2. my_allowed_modules — drives the switcher in every app
--
-- 166's body + the personal-grant arm.
--
-- NOTE the personal arm does NOT join public.departments. A grant made to an
-- individual must hold whether or not they have a department, and whether or
-- not that department is active — requiring d.active here would silently kill
-- exactly the grants that exist because the department was the wrong unit.
-- u.active still applies: 166's F2 offboarding fix is about the person, and a
-- deactivated employee must lose personal grants like any other.
--------------------------------------------------------------------------------
create or replace function public.my_allowed_modules()
returns table (
    key         text,
    name        text,
    href        text,
    description text,
    sort_order  integer
)
language plpgsql stable security definer set search_path = public, pg_temp
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
                   and coalesce(u.active, true)        -- (F2) skip deactivated staff
                  join public.departments d
                    on d.id = a.department_id
                   and coalesce(d.active, true)        -- (F1) skip deactivated depts
                 where a.module_key      = m.key
                   and a.organisation_id = v_org))
          or (v_org is not null and exists (           -- personal grant (177)
                select 1
                  from public.user_module_access ua
                  join public.users u
                    on u.id            = ua.user_id
                   and u.auth_user_id  = auth.uid()
                   and coalesce(u.active, true)
                 where ua.module_key      = m.key
                   and ua.organisation_id = v_org))
       )
     order by m.sort_order, m.name;
end$$;

revoke all on function public.my_allowed_modules() from public, anon;
grant execute on function public.my_allowed_modules() to authenticated;


--------------------------------------------------------------------------------
-- 3. module_access_granted — the per-module entry predicate
--
-- 166's body + the personal-grant arm. The fail-closed exception handler (F4)
-- is preserved: the header of 164 promises this never raises so it is safe
-- inside an RLS policy.
--------------------------------------------------------------------------------
create or replace function public.module_access_granted(p_module_key text)
returns boolean
language plpgsql stable security definer set search_path = public, pg_temp
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

    if exists (
        select 1
          from public.dept_module_access a
          join public.users u
            on u.department_id   = a.department_id
           and u.auth_user_id    = auth.uid()
           and coalesce(u.active, true)            -- (F2) skip deactivated staff
          join public.departments d
            on d.id = a.department_id
           and coalesce(d.active, true)            -- (F1) skip deactivated depts
          join public.erp_modules m
            on m.key = a.module_key and m.active
         where a.module_key      = p_module_key
           and a.organisation_id = v_org) then
        return true;
    end if;

    -- Personal grant (177). No departments join — see the note on
    -- my_allowed_modules above.
    return exists (
        select 1
          from public.user_module_access ua
          join public.users u
            on u.id            = ua.user_id
           and u.auth_user_id  = auth.uid()
           and coalesce(u.active, true)
          join public.erp_modules m
            on m.key = ua.module_key and m.active
         where ua.module_key      = p_module_key
           and ua.organisation_id = v_org);
exception
    -- (F4) The header promises this never raises so it is safe embedded in an
    -- RLS policy; a future dependency change must fail CLOSED, not error the
    -- whole policy.
    when others then
        return false;
end$$;

revoke all on function public.module_access_granted(text) from public, anon;
grant execute on function public.module_access_granted(text) to authenticated;


--------------------------------------------------------------------------------
-- 4. list_module_access_matrix — the Configure grid (developers only)
--
-- Extended with `users` and `user_grants` so the whole tab, both halves, loads
-- in one round trip. The return type is jsonb and this is its only consumer,
-- so adding keys is free — no DROP, no return-type change.
--
-- Each user carries `department_id` (so the UI can show what they already
-- inherit) and `sees_everything` (admin or developer — their checkboxes would
-- otherwise lie, since 164 gives those roles every module unconditionally).
--------------------------------------------------------------------------------
create or replace function public.list_module_access_matrix(p_org_id bigint default null)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
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
             where a.organisation_id = v_org), '[]'::jsonb),
        'users', coalesce((
            select jsonb_agg(jsonb_build_object(
                     'id', u.id, 'name', u.name,
                     'department_id', u.department_id,
                     'sees_everything', exists (
                         select 1 from public.admins ad
                          where ad.user_id = u.auth_user_id
                            and (ad.role = 'developer' or ad.organisation_id = v_org)))
                   order by lower(u.name))
              from public.users u
             where u.organisation_id = v_org
               and coalesce(u.active, true)), '[]'::jsonb),
        'user_grants', coalesce((
            select jsonb_agg(jsonb_build_object(
                     'user_id', ua.user_id, 'module_key', ua.module_key))
              from public.user_module_access ua
             where ua.organisation_id = v_org), '[]'::jsonb));
end$$;

revoke all on function public.list_module_access_matrix(bigint) from public, anon;
grant execute on function public.list_module_access_matrix(bigint) to authenticated;


--------------------------------------------------------------------------------
-- 5. set_user_module_access — one checkbox toggle (developers only)
--
-- Mirrors set_dept_module_access clause for clause, including the cross-org
-- guard: never let a developer grant one org's employee access by passing
-- another org's id.
--------------------------------------------------------------------------------
create or replace function public.set_user_module_access(
    p_user_id    bigint,
    p_module_key text,
    p_allowed    boolean,
    p_org_id     bigint default null
)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
    v_org    bigint;
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

    if not exists (select 1 from public.users u
                    where u.id = p_user_id and u.organisation_id = v_org) then
        raise exception 'employee % is not in organisation %', p_user_id, v_org;
    end if;

    if p_allowed then
        insert into public.user_module_access (organisation_id, user_id, module_key)
        values (v_org, p_user_id, p_module_key)
        on conflict (organisation_id, user_id, module_key) do nothing;
    else
        delete from public.user_module_access
         where organisation_id = v_org
           and user_id         = p_user_id
           and module_key      = p_module_key;
    end if;
end$$;

revoke all on function public.set_user_module_access(bigint, text, boolean, bigint) from public, anon;
grant execute on function public.set_user_module_access(bigint, text, boolean, bigint) to authenticated;

notify pgrst, 'reload schema';


--------------------------------------------------------------------------------
-- VERIFICATION
--------------------------------------------------------------------------------
-- 1. Matrix payload now carries both new keys (as a developer):
--      select jsonb_object_keys(public.list_module_access_matrix(1));
--      -- expect: is_developer, organisation_id, modules, departments,
--      --         grants, users, user_grants
--
-- 2. Grant one module to one person whose department has nothing:
--      select public.set_user_module_access(<user_id>, 'map', true, 1);
--    Then, signed in AS that person — expect 'timesheet' and 'map':
--      select * from public.my_allowed_modules();
--      select public.module_access_granted('map');       -- true
--      select public.module_access_granted('spares');    -- false
--
-- 3. Additive, not subtractive — with a department grant on 'map' and NO
--    personal grant, the person still sees it. Deleting the personal row
--    changes nothing:
--      select public.set_user_module_access(<user_id>, 'map', false, 1);
--      select public.module_access_granted('map');       -- still true
--
-- 4. Timesheet cannot be revoked — expect an exception:
--      select public.set_user_module_access(<user_id>, 'timesheet', false, 1);
--
-- 5. Cross-org guard — expect 'employee % is not in organisation %':
--      select public.set_user_module_access(<user_from_org_2>, 'map', true, 1);
--
-- 6. Deactivated employee keeps nothing (F2 still holds for personal grants):
--      update public.users set active = false where id = <user_id>;
--      -- as that user: select public.module_access_granted('map');  -- false
--
-- 7. Regression — a department grant on its own still works exactly as before:
--      select * from public.my_allowed_modules();
--
-- Who has a personal grant right now, and is it doing anything the department
-- did not already do?
--
--   select u.name, ua.module_key,
--          exists (select 1 from public.dept_module_access da
--                   where da.department_id = u.department_id
--                     and da.module_key    = ua.module_key
--                     and da.organisation_id = ua.organisation_id) as redundant
--     from public.user_module_access ua
--     join public.users u on u.id = ua.user_id
--    order by lower(u.name), ua.module_key;
