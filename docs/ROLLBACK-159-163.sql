-- ROLLBACK-159-163.sql
-- Undo script for the August 2026 security audit migrations.
-- NOT a migration — do not apply this in sequence. Each block is
-- independent; run only the one you need.
--
-- Every block restores the PRE-AUDIT behaviour, which means restoring the
-- vulnerability it fixed. Use to unblock a production problem, then fix
-- forward — don't leave these in place.

--------------------------------------------------------------------------------
-- ROLLBACK 159 — clock report RPC gate
-- Restores: any authenticated user can read any org's live status and
-- off-site history (audit A2).
--
-- Symptom that would make you run this: the Timeclock page (either app)
-- errors with "structure of query does not match function result type",
-- meaning the live implementation returns different columns than the
-- wrapper declares.
--------------------------------------------------------------------------------

-- drop the gated wrapper, put the implementation back at its original name
drop function if exists public.org_live_status(bigint);
alter function public._org_live_status_impl(bigint) rename to org_live_status;
grant execute on function public.org_live_status(bigint) to authenticated;

drop function if exists public._offsite_report(bigint, date, date, text);
alter function public._offsite_report_impl(bigint, date, date, text) rename to _offsite_report;
grant execute on function public._offsite_report(bigint, date, date, text) to authenticated;

--------------------------------------------------------------------------------
-- ROLLBACK 160 — manager read scope
-- Restores: department leads read every user (incl. cost_rate/sell_rate)
-- and every timesheet in the organisation (audit A4).
--
-- Symptom: a department lead reports missing employees or blank donuts on
-- /department.html.
--------------------------------------------------------------------------------

drop policy if exists "dept managers read own reports" on public.users;
create policy "dept managers read org users"
    on public.users for select
    using (public.user_is_dept_manager_in_org(organisation_id));

drop policy if exists "managers read dept timesheets" on public.timesheets;
create policy "managers read dept timesheets"
    on public.timesheets for select to authenticated
    using (exists (
        select 1 from public.users mgr
         where mgr.auth_user_id    = auth.uid()
           and mgr.is_manager      = true
           and mgr.organisation_id = timesheets.organisation_id));

drop policy if exists "managers read dept entries" on public.timesheet_entries;
create policy "managers read dept entries"
    on public.timesheet_entries for select to authenticated
    using (exists (
        select 1 from public.timesheets ts
          join public.users mgr on mgr.auth_user_id = auth.uid()
         where ts.id = timesheet_entries.timesheet_id
           and mgr.is_manager      = true
           and mgr.organisation_id = ts.organisation_id));

--------------------------------------------------------------------------------
-- ROLLBACK 161 — organisations read scope
-- Restores: every authenticated user reads every organisation row (A6).
--
-- Symptom: the developer org switcher is empty, or a page silently falls
-- back to defaults (deadlines, holiday autofill, clock tolerance) — these
-- degrade quietly rather than erroring, because the client uses
-- maybeSingle() with fallbacks.
--
-- NOT a symptom: approval routing. approval_workflow is read inside
-- SECURITY DEFINER functions (submit_leave_request 126:74,
-- approve_leave_request / manager_approve_leave_request in 150), which
-- bypass RLS. Approvals route from the real column value regardless of
-- this policy. The client-side reads of approval_workflow only choose
-- which buttons to render, and every role in the approval path satisfies
-- the policy anyway.
--------------------------------------------------------------------------------

drop policy if exists "members read own organisation" on public.organisations;
create policy "read organisations"
    on public.organisations for select to authenticated
    using (true);

--------------------------------------------------------------------------------
-- ROLLBACK 162 — login audit trail
-- Mostly additive, so a full rollback is rarely needed. The two things
-- that could misbehave are the cron job and the anon write path.
--------------------------------------------------------------------------------

-- Just stop the nightly prune (keeps everything else):
-- select cron.unschedule('prune-login-attempts');

-- Make the lockout count client-reported rows again (RE-OPENS the A5
-- lockout DoS — only do this if you have enabled the 142 auth hook and
-- something is wrong with the source filter):
-- create or replace function public.check_login_locked(p_email text)
-- returns boolean language sql security definer set search_path = public stable
-- as $$
--   select (select count(*) from public.login_attempts
--            where email = lower(coalesce(p_email, ''))
--              and succeeded = false
--              and attempted_at > now() - interval '15 minutes') >= 5;
-- $$;

-- Full revert of the column (destroys the provenance data):
-- alter table public.login_attempts drop constraint if exists login_attempts_source_check;
-- drop index if exists public.login_attempts_lockout_idx;
-- alter table public.login_attempts drop column if exists source;

--------------------------------------------------------------------------------
-- ROLLBACK 163 — provisioning link guard
-- Restores: provision_employee_login will link an auth identity that
-- another employee record already owns (audit A9).
--
-- Symptom: an admin legitimately needs to re-link an account and is
-- blocked by 'That email already has a login linked to employee record N'.
-- Prefer clearing the stale users.auth_user_id row over running this.
--------------------------------------------------------------------------------

drop index if exists public.users_auth_user_id_uniq;
-- then re-apply migration 140_random_temp_passwords.sql, which contains
-- the previous (unguarded) definition of provision_employee_login.
