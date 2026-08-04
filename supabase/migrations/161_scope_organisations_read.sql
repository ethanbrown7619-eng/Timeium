-- 161_scope_organisations_read.sql
-- Security audit 2026-08, finding A6 (Low): the organisations SELECT
-- policy is still
--
--     create policy "read organisations" on public.organisations
--       for select to authenticated using (true);
--
-- so any authenticated user in any organisation can read every other
-- organisation's row.
--
-- This is the residue of audit finding C1. Migration 141 did the urgent
-- half — it moved SMTP passwords and the jobs/tasks/dept-codes webhook
-- keys into the admin-scoped org_secrets table and NULLed the old columns,
-- which genuinely closed the secret exposure. What it did not do is narrow
-- the policy itself.
--
-- What is still readable cross-tenant today: organisation names and slugs,
-- approval_workflow, the deadline / reminder / overdue / discrepancy
-- schedules, notify_overdue_recipient, clock_tolerance_hours,
-- employment_type_settings, and the jobs/tasks/dept_codes import maps.
-- No secrets — but it is an open multi-tenant boundary, and it will
-- silently re-expose anything a future migration adds to this table.
-- That is exactly the shape C1 had.
--
-- Fix: restrict to admins of the org (is_admin_of, which also returns
-- true for developers against any org, preserving the org switcher) or
-- members of it (a users row bound to the caller).
--
-- Verified against every reader before writing this:
--   shared.js:953        developers only, lists all orgs  -> is_admin_of (developer) ✓
--   shared.js:876        own org employment_type_settings -> membership ✓
--   department.js:93     own org approval settings        -> membership ✓
--   timesheet.js:1924    own org deadline/holiday config  -> membership ✓
--   timesheet-view.js:186 own org approval_workflow       -> membership ✓
--   timeclock.js:569     own org clock tolerance          -> membership ✓
--   admin.js:279         own org, admin page              -> is_admin_of ✓
--   configure.js:348/740/1279  own org, admin page        -> is_admin_of ✓
-- Every non-developer read is `.eq("id", <their own org>)`, so membership
-- covers them all.
--
-- Safe to re-run.

drop policy if exists "read organisations" on public.organisations;
drop policy if exists "members read own organisation" on public.organisations;

create policy "members read own organisation"
    on public.organisations for select
    to authenticated
    using (
        public.is_admin_of(id)
        or exists (
            select 1 from public.users u
             where u.auth_user_id    = auth.uid()
               and u.organisation_id = organisations.id
        )
    );

--------------------------------------------------------------------------------
-- VERIFICATION
--
-- 1. Policy is in place and no longer `true`:
--
--      select policyname, qual from pg_policies
--       where schemaname = 'public' and tablename = 'organisations';
--
-- 2. As a DEVELOPER: the org switcher in the topbar must still list every
--    organisation (/admin.html).
--
-- 3. As an ADMIN: /admin.html and /configure.html load their org settings
--    normally, and
--      await sb.from("organisations").select("id,name");
--    returns ONLY their own organisation.
--
-- 4. As an EMPLOYEE: /timesheet.html still applies the deadline and
--    public-holiday autofill settings, and the same query returns only
--    their own organisation.
--------------------------------------------------------------------------------
