-- 160_narrow_manager_read_scope.sql
-- Security audit 2026-08, finding A4 (Medium): the department-lead read
-- policies are organisation-wide despite being named for department scope.
--
-- There are two distinct "manager" concepts (see migration 053):
--
--   1. admins.role in ('manager','admin')  — org-level role. Genuinely
--      org-wide by design; is_admin_of() already returns true for these
--      (it matches on organisation_id without inspecting role), so they
--      keep full org visibility. NOT changed by this migration.
--
--   2. users.is_manager = true             — department-lead flag set on
--      the Staff page. Should only ever see the people they actually
--      lead, i.e. members of a department whose departments.manager_id
--      is them. This is what was wrong.
--
-- Three policies granted concept (2) the whole organisation:
--
--   users              "dept managers read org users"
--                      using user_is_dept_manager_in_org(organisation_id)
--   timesheets         "managers read dept timesheets"
--   timesheet_entries  "managers read dept entries"
--                      using (mgr.is_manager and mgr.organisation_id = ...)
--
-- Concretely: public/js/shared.js:327 (fetchWeekDashboardData) issues
--     select id, name, department_id, active, cost_rate, sell_rate, ...
--     from users where organisation_id = <org>
-- on every load of /department.html. Under the old policies a department
-- lead received EVERY employee's cost_rate and sell_rate in the browser,
-- plus every timesheet and every timesheet entry in the organisation.
-- The page then filtered to managed departments client-side — which is a
-- display filter, not a boundary.
--
-- Fix: key all three on public.user_manages_target_user(), the correctly
-- department-scoped helper that migration 118 already uses for the WRITE
-- policies. Reads and writes then have the same scope, which is what the
-- policy names claimed all along.
--
-- No client change is needed: department.js already narrows to
-- `d.manager_id === employee.id` itself, so it renders the same thing —
-- it just stops being handed everyone else's data first.
--
-- Residual, accepted: a department lead still sees cost_rate / sell_rate
-- for their own direct reports (fetchWeekDashboardData needs them for the
-- effective-overhead calculation). Removing rates from leads entirely
-- would need a column-limited view plus a client change; row scope was
-- the disproportionate part and is what this fixes.
--
-- Not affected: admins, org-level managers and developers (is_admin_of),
-- clock viewers (user_can_view_clock_comparison), employees reading their
-- own rows, and the manager WRITE policies from 118.
--
-- Safe to re-run.

--------------------------------------------------------------------------------
-- users — department leads see their own reports, not the whole roster
--------------------------------------------------------------------------------

drop policy if exists "dept managers read org users" on public.users;
drop policy if exists "dept managers read own reports" on public.users;

create policy "dept managers read own reports"
    on public.users for select
    to authenticated
    using (public.user_manages_target_user(id));

--------------------------------------------------------------------------------
-- timesheets — department leads read their reports' timesheets only
--------------------------------------------------------------------------------

drop policy if exists "managers read dept timesheets" on public.timesheets;

create policy "managers read dept timesheets"
    on public.timesheets for select
    to authenticated
    using (public.user_manages_target_user(user_id));

--------------------------------------------------------------------------------
-- timesheet_entries — same narrowing, via the parent timesheet
--------------------------------------------------------------------------------

drop policy if exists "managers read dept entries" on public.timesheet_entries;

create policy "managers read dept entries"
    on public.timesheet_entries for select
    to authenticated
    using (
        exists (
            select 1
              from public.timesheets ts
             where ts.id = timesheet_entries.timesheet_id
               and public.user_manages_target_user(ts.user_id)
        )
    );

--------------------------------------------------------------------------------
-- clock_roster — compensating control for the Timeclock page
--------------------------------------------------------------------------------
-- The narrowing above would otherwise break an existing, deliberate
-- feature. /timeclock.html admits three roles (timeclock.js:
-- isAdminOrDev || isManager || isClockViewer) and its Live view is
-- designed to list EVERY employee in the organisation — it reads the
-- active roster to inject "not clocked in" rows for staff the live RPC
-- doesn't return, and to decorate rows with employment_type.
--
-- Admins and clock viewers still read that roster through their own
-- policies. A department lead who is neither (is_manager = true, no
-- admins row, can_view_clock_comparison = false) would have seen their
-- roster silently shrink to their own reports, while the live RPC kept
-- returning the whole org — a half-populated, inconsistent page.
--
-- Column-level grants can't solve this: department leads and admins are
-- the same database role (`authenticated`), so nothing at the GRANT layer
-- can show cost_rate to one and hide it from the other. Only the row
-- scope above can distinguish them. So the roster moves to a SECURITY
-- DEFINER RPC that returns the org-wide list WITHOUT any rate columns,
-- gated on the same three roles the page admits.
--
-- Net effect: the Timeclock page behaves exactly as it does today for
-- every role, while pay rates stay behind the narrowed row policy.

create or replace function public.clock_roster(p_org_id bigint)
returns table (
    id              bigint,
    name            text,
    department_id   bigint,
    employment_type text,
    active          boolean
)
language plpgsql stable security definer set search_path = public
as $function$
begin
    if p_org_id is null then
        return;
    end if;

    if not (public.is_admin_of(p_org_id)
            or public.user_is_dept_manager_in_org(p_org_id)
            or public.user_can_view_clock_comparison(p_org_id)) then
        raise exception 'not authorised';
    end if;

    -- Deliberately no cost_rate / sell_rate. This is a display roster.
    return query
        select u.id, u.name, u.department_id, u.employment_type, u.active
          from public.users u
         where u.organisation_id = p_org_id;
end$function$;

revoke all on function public.clock_roster(bigint) from public, anon;
grant execute on function public.clock_roster(bigint) to authenticated;

--------------------------------------------------------------------------------
-- VERIFICATION
--
-- 0. Timeclock roster, as a DEPARTMENT LEAD (is_manager = true, no admins
--    row, can_view_clock_comparison = false):
--
--      await sb.rpc("clock_roster", { p_org_id: <their org> });
--
--    must return the whole organisation, with no rate columns. As a plain
--    employee it must raise 'not authorised'.
--
-- 1. Confirm the three policies now reference the scoped helper:
--
--      select tablename, policyname, qual
--        from pg_policies
--       where schemaname = 'public'
--         and policyname in ('dept managers read own reports',
--                            'managers read dept timesheets',
--                            'managers read dept entries')
--       order by tablename;
--
--    Each `qual` must mention user_manages_target_user, and none should
--    mention user_is_dept_manager_in_org.
--
-- 2. As a DEPARTMENT LEAD (users.is_manager = true, no admins row):
--
--      -- must return only their own reports, not the whole org
--      await sb.from("users").select("id,name,cost_rate").eq("organisation_id", <org>);
--
--    and /department.html must still render its donuts and employee list.
--
-- 3. As an ADMIN: /department.html, /staff.html and /admin.html must be
--    unchanged (they go through is_admin_of, untouched here).
--
-- NOTE: user_is_dept_manager_in_org() is no longer used by any RLS policy,
-- but it is now the department-lead branch of the gate in clock_roster()
-- above and in both wrappers in migration 159. Do not drop it.
--------------------------------------------------------------------------------
