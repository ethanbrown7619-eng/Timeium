-- ============================================================================
-- 190_timesheet_rows_not_public.sql - close a regression of a fix Timeium's
-- docs believe shipped in 149, plus three more no-guard functions it owns.
-- GRANTS ONLY; no function body is changed. Found in the 2026-09-24 audit.
--
-- REPO TOPOLOGY: this database is shared with the sibling PTL-clock-in-out
-- repo (C:\erp\Time\PTL-clock-in-out). public.weekly_hours and the
-- close_stale_shifts / close_all_stale_shifts / _close_present_guests_for_org /
-- _nudge_guest_notifications family are defined THERE (003/018/204/206) and
-- are fixed in PTL-clock-in-out 211, not here.
--
-- public._timesheet_rows(p_org_id, p_start, p_end_excl, p_tz) - HIGH.
-- The whole clock-report engine (tolerance rounding, breaks, red/yellow/orange
-- flags). docs/RPC-REFERENCE.md says it has no in-body auth check by design and
-- was "already revoked from public" in 149; production disagrees: anon and
-- authenticated both hold EXECUTE today. Anyone with the publishable key can
-- call it for ANY organisation id and ANY date range and get every employee's
-- clock times, hours and lateness flags, with none of the wrappers' checks.
-- Proven on the Tokyo copy (rolled back): as anon with request.jwt.claims
-- cleared it returned real employee rows; after this file, insufficient_privilege.
-- Legitimate callers, all unaffected:
--   * public.weekly_timesheet() and public.timesheet_for_range() - SECURITY
--     DEFINER wrappers owned by postgres (implicit EXECUTE), gated by an admins
--     row / users.can_view_clock_comparison / resolve_org_id();
--   * PTL-clock-in-out/supabase/functions/send-weekly-flags/index.ts calls
--     _timesheet_rows DIRECTLY with SUPABASE_SERVICE_ROLE_KEY - service_role is
--     granted by name below (no cron.job schedules it on Sydney today, so it is
--     dormant, but it keeps working if re-enabled).
--
-- public.snapshot_timesheet_job_statuses(p_timesheet_id) - LOW-MEDIUM. No
-- guard; can only fill a NULL job_status_snapshot with the job's CURRENT
-- status, but anon can force an early snapshot on ANY timesheet. Called from
-- public/js/timesheet.js by a signed-in employee: authenticated kept.
--
-- public.seed_default_leave_types(p_org_id) and
-- public.seed_public_holidays_for_year(p_org_id, p_year) - MEDIUM. No guard;
-- both INSERT ... ON CONFLICT DO NOTHING into a caller-supplied organisation.
-- 041/045 granted authenticated only; anon is drift through PUBLIC.
-- seed_public_holidays_for_year is the Configure "Generate NZ holidays" button
-- (public/js/configure.js), signed in: authenticated kept.
-- seed_default_leave_types has NO client caller anywhere (an onboarding
-- helper run from the SQL editor) and no org check, so a signed-in employee
-- could seed another org's leave types: authenticated revoked as well,
-- service_role only. SQL-editor use (postgres, the owner) is unaffected.
--
-- Why "from public, anon" and explicit re-grants: in schema public the
-- database's default privileges hand every new function a NAMED grant to
-- anon, authenticated and service_role, and older functions also still carry
-- the factory EXECUTE-to-PUBLIC. Both are removed; keep-roles are re-granted
-- by name so nothing depends on the PUBLIC grant being there.
--
-- Follow-ups NOT done here (body changes): neither seed function checks the
-- caller's org against p_org_id; snapshot_timesheet_job_statuses does not
-- check the caller owns p_timesheet_id.
--
-- Idempotent. ASCII-only. One transaction.
-- ============================================================================

begin;

revoke execute on function public._timesheet_rows(bigint, date, date, text) from public, anon, authenticated;
grant  execute on function public._timesheet_rows(bigint, date, date, text) to service_role;

revoke execute on function public.snapshot_timesheet_job_statuses(bigint) from public, anon;
grant  execute on function public.snapshot_timesheet_job_statuses(bigint) to authenticated, service_role;

revoke execute on function public.seed_default_leave_types(bigint) from public, anon, authenticated;
grant  execute on function public.seed_default_leave_types(bigint) to service_role;

revoke execute on function public.seed_public_holidays_for_year(bigint, integer) from public, anon;
grant  execute on function public.seed_public_holidays_for_year(bigint, integer) to authenticated, service_role;

commit;

-- VERIFICATION. Expected: anon_x = f on every row; auth_x = f for
-- _timesheet_rows and seed_default_leave_types, t for
-- snapshot_timesheet_job_statuses and seed_public_holidays_for_year; svc_x = t
-- on every row; the two wrappers keep their existing grants (anon may show t
-- there - they are gated in-body and are NOT changed by this file).
select fn,
       has_function_privilege('anon',          fn, 'execute') as anon_x,
       has_function_privilege('authenticated', fn, 'execute') as auth_x,
       has_function_privilege('service_role',  fn, 'execute') as svc_x
from unnest(array[
  'public._timesheet_rows(bigint,date,date,text)',
  'public.snapshot_timesheet_job_statuses(bigint)',
  'public.seed_default_leave_types(bigint)',
  'public.seed_public_holidays_for_year(bigint,integer)',
  'public.weekly_timesheet(date,text,bigint)',
  'public.timesheet_for_range(date,date,text,bigint)']) as fn;
