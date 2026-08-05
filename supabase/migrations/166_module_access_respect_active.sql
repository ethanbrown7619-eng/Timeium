-- 166_module_access_respect_active.sql
--
-- Security audit 2026-08-06, findings F1/F2: the module-access readers only
-- joined `dept_module_access -> users` on department_id, so they ignored
-- BOTH `departments.active` and `users.active`. Consequences:
--   * A deactivated department's grants stayed live (grant rows cascade on
--     DELETE, not on deactivate), while vanishing from the Configure grid —
--     an effective, invisible, unrevocable grant. (F1)
--   * A deactivated employee whose JWT still worked kept full module access
--     until token expiry — an offboarding gap. (F2)
--
-- This migration re-issues `my_allowed_modules()` and
-- `module_access_granted()` verbatim EXCEPT that the grant lookup now also
-- requires the caller's user row to be active AND the granted department to
-- be active. Definers only; grants preserved by create-or-replace. It also
-- wraps `module_access_granted`'s body in a fail-closed exception handler so
-- the header's "never raises" guarantee (it is safe inside an RLS policy) is
-- backed by code, not just by construction. (F4)
--
-- Safe to re-run.

--------------------------------------------------------------------------------
-- my_allowed_modules — drives the switcher
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
       )
     order by m.sort_order, m.name;
end$$;

revoke all on function public.my_allowed_modules() from public, anon;
grant execute on function public.my_allowed_modules() to authenticated;

--------------------------------------------------------------------------------
-- module_access_granted — the per-module entry predicate (Phase 2)
--------------------------------------------------------------------------------
create or replace function public.module_access_granted(p_module_key text)
returns boolean
language plpgsql stable security definer set search_path = public, pg_temp
as $$
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

    declare v_org bigint;
    begin
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
               and coalesce(u.active, true)            -- (F2) skip deactivated staff
              join public.departments d
                on d.id = a.department_id
               and coalesce(d.active, true)            -- (F1) skip deactivated depts
              join public.erp_modules m
                on m.key = a.module_key and m.active
             where a.module_key      = p_module_key
               and a.organisation_id = v_org);
    end;
exception
    -- (F4) The header promises this never raises so it is safe embedded in an
    -- RLS policy; a future dependency change must fail CLOSED, not error the
    -- whole policy.
    when others then
        return false;
end$$;

revoke all on function public.module_access_granted(text) from public, anon;
grant execute on function public.module_access_granted(text) to authenticated;

notify pgrst, 'reload schema';

-- VERIFICATION
--   As a deactivated employee (users.active=false) whose JWT is still valid:
--     select public.module_access_granted('map');   -- expect false
--     select * from public.my_allowed_modules();     -- expect only timesheet
--   As an active employee with a grant on an active dept: unchanged (true / row present).
