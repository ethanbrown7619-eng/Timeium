-- 159_gate_clock_report_rpcs.sql
-- Security audit 2026-08, finding A2 (High): public.org_live_status and
-- public._offsite_report are SECURITY DEFINER (so they bypass RLS), are
-- granted EXECUTE to `authenticated`, take the organisation id straight
-- from the caller, and perform NO authorisation check at all.
--
-- Net effect: any signed-in user — a plain employee with no admins row,
-- is_manager = false and can_view_clock_comparison = false — could call
--
--     POST /rest/v1/rpc/org_live_status   {"p_org_id": <any org>}
--     POST /rest/v1/rpc/_offsite_report   {"p_org_id": <any org>, ...}
--
-- and read every employee's name, department, live on-site/off-site
-- status, break detail, off-site spells, break overruns, late-backs and
-- clock-out-early events — for their own organisation AND for every
-- other organisation in this shared Supabase project.
--
-- The sibling function weekly_timesheet already does this correctly
-- (resolve admin row -> else can_view_clock_comparison -> else raise,
-- and explicitly refuses an org override for non-admins). This migration
-- applies the same gate to the two that were missed.
--
-- SCOPE: this migration changes AUTHORISATION ONLY. For a caller who was
-- always meant to have access (admin, developer, clock viewer) the
-- behaviour — including argument handling, row output and the empty
-- result for a null org id — is byte-for-byte what it was before. No
-- range limits, no extra validation, nothing else added. That is
-- deliberate: PTL Clock's admin page drives _offsite_report from
-- free-form date pickers with no upper bound, and any restriction added
-- here would break a legitimate report in the other app.
--
--------------------------------------------------------------------------------
-- WHY THIS DOES NOT REWRITE THE FUNCTION BODIES
--------------------------------------------------------------------------------
-- These are PTL Clock-owned functions and the repo copies DISAGREE:
-- Timeium's 149/151 and Clock's 208_offsite_personal.sql all recreate
-- _offsite_report with different bodies (208 adds the off_site_personal
-- status; 149/151 do not). Whichever was applied last is what's live, and
-- there is no way to tell from the repos. Recreating the body from either
-- copy would silently revert whichever change lost the race — exactly the
-- shared-function clobbering the developer guide warns about.
--
-- So instead of touching the bodies, we RENAME each implementation and
-- put a gated wrapper at the original name:
--
--     org_live_status(bigint)   -> _org_live_status_impl(bigint)     [body untouched]
--     _offsite_report(...)      -> _offsite_report_impl(...)         [body untouched]
--
-- and create org_live_status / _offsite_report as thin SECURITY DEFINER
-- wrappers that check the caller and then delegate. Name, argument list
-- and return columns are all unchanged, so NEITHER app needs a client
-- change — PTL Timesheet's timeclock.js and PTL Clock's admin.js keep
-- calling exactly what they call today. This mirrors the existing
-- _timesheet_rows / weekly_timesheet split already in this database.
--
-- The return-column lists declared below were checked against every copy
-- in both repos (org_live_status: 024, 028, 149 — 7 columns;
-- _offsite_report: 026, 028, 149, 151, 208 — 14 columns). All agree.
--
--------------------------------------------------------------------------------
-- !! CROSS-REPO COORDINATION — READ BEFORE THE NEXT PTL CLOCK MIGRATION !!
--------------------------------------------------------------------------------
-- A future PTL Clock migration that runs
--
--     create or replace function public.org_live_status(bigint) ...
--     create or replace function public._offsite_report(bigint,date,date,text) ...
--
-- will overwrite the WRAPPER with an ungated body and silently reopen this
-- hole. Clock migrations 024, 026, 028 and 208 all also carry
-- `grant execute on function public._offsite_report(...) to authenticated`,
-- so re-running any of them re-grants the ungated path too.
--
-- Mitigations, in order:
--   1. Copy this migration into the PTL Clock repo so its history records
--      the gate, and note in that repo that org_live_status /
--      _offsite_report are now wrappers — future edits belong in the
--      *_impl functions.
--   2. Re-running THIS migration is the repair, and it is a TRUE repair:
--      the blocks below detect whether the public name currently holds our
--      wrapper or a real implementation. If PTL Clock has overwritten the
--      wrapper with a new body, that NEW body is moved into *_impl (the
--      stale one is discarded) and the wrapper is rebuilt over it — so the
--      Clock change is preserved, not reverted.
--   3. Verify after any Clock deploy with the catalog probe at the bottom
--      of this file.
--
-- Safe to re-run.

--------------------------------------------------------------------------------
-- 1. org_live_status — move the real implementation into *_impl
--
-- Three states are handled:
--   a) first run           -> public name holds the implementation: move it
--   b) ordinary re-run     -> public name holds our wrapper: nothing to move
--   c) clobbered by Clock  -> public name holds a NEW implementation: discard
--                             the stale *_impl and move the new body in
-- The wrapper is identified by the marker token in its body.
--------------------------------------------------------------------------------

do $$
declare
    v_def text;
begin
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'org_live_status'
       and pg_get_function_identity_arguments(p.oid) = 'p_org_id bigint';

    if v_def is null then
        raise warning 'org_live_status(bigint) not found — PTL Clock functions are not installed here; skipping';
        return;
    end if;

    -- Already our wrapper: leave the implementation alone.
    if v_def like '%[159-gate-wrapper]%' then
        return;
    end if;

    -- Public name holds a real implementation. Anything sitting in *_impl
    -- is older than it by definition, so discard it and take this body.
    drop function if exists public._org_live_status_impl(bigint);
    execute 'alter function public.org_live_status(bigint) rename to _org_live_status_impl';
end$$;

-- The rename carries the old grants with it. Strip them: nothing should
-- reach the ungated implementation directly.
do $$
begin
    if exists (
        select 1 from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = '_org_live_status_impl'
    ) then
        execute 'revoke all on function public._org_live_status_impl(bigint) '
             || 'from public, anon, authenticated';
    end if;
end$$;

--------------------------------------------------------------------------------
-- 2. org_live_status — gated wrapper at the original name/signature
--------------------------------------------------------------------------------

create or replace function public.org_live_status(p_org_id bigint)
returns table (
    user_id     bigint,
    name        text,
    department  text,
    status      text,
    break_id    bigint,
    break_name  text,
    since       timestamptz
)
language plpgsql stable security definer set search_path = public
as $function$
begin
    -- [159-gate-wrapper] marker — do not remove; this migration uses it to
    -- tell its own wrapper apart from a real implementation on re-run.

    -- A null org previously produced an empty result rather than an error.
    -- Preserve that exactly: return zero rows, raise nothing.
    if p_org_id is null then
        return;
    end if;

    -- is_admin_of() already returns true for developers against any org,
    -- which preserves the org switcher (and PTL Clock's admin page, which
    -- requires an admins row). user_can_view_clock_comparison() pins the
    -- caller to their own organisation, so a clock viewer cannot pass
    -- someone else's org id.
    -- The gate mirrors the access model the Timeclock page already
    -- implements client-side (timeclock.js: isAdminOrDev || isManager ||
    -- isClockViewer). The finding was that NOTHING enforced it server-side
    -- and the org id was unchecked — not that the model was wrong. All
    -- three helpers pin the caller to p_org_id, except is_admin_of, which
    -- also returns true for developers against any org (preserving the org
    -- switcher and PTL Clock's admin page).
    if not (public.is_admin_of(p_org_id)
            or public.user_is_dept_manager_in_org(p_org_id)
            or public.user_can_view_clock_comparison(p_org_id)) then
        raise exception 'not authorised';
    end if;

    return query select * from public._org_live_status_impl(p_org_id);
end$function$;

revoke all on function public.org_live_status(bigint) from public, anon;
grant execute on function public.org_live_status(bigint) to authenticated;

--------------------------------------------------------------------------------
-- 3. _offsite_report — move the real implementation into *_impl
--------------------------------------------------------------------------------

do $$
declare
    v_def text;
begin
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = '_offsite_report'
       and pg_get_function_identity_arguments(p.oid)
           = 'p_org_id bigint, p_start date, p_end_excl date, p_tz text';

    if v_def is null then
        raise warning '_offsite_report(bigint,date,date,text) not found — PTL Clock functions are not installed here; skipping';
        return;
    end if;

    if v_def like '%[159-gate-wrapper]%' then
        return;
    end if;

    drop function if exists public._offsite_report_impl(bigint, date, date, text);
    execute 'alter function public._offsite_report(bigint, date, date, text) '
         || 'rename to _offsite_report_impl';
end$$;

do $$
begin
    if exists (
        select 1 from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = '_offsite_report_impl'
    ) then
        execute 'revoke all on function public._offsite_report_impl(bigint, date, date, text) '
             || 'from public, anon, authenticated';
    end if;
end$$;

--------------------------------------------------------------------------------
-- 4. _offsite_report — gated wrapper at the original name/signature
--------------------------------------------------------------------------------

create or replace function public._offsite_report(
    p_org_id    bigint,
    p_start     date,
    p_end_excl  date,
    p_tz        text
)
returns table (
    user_id           bigint,
    name              text,
    department        text,
    day               date,
    reason            text,
    status            text,
    break_paid        boolean,
    started_at        timestamptz,
    returned_at       timestamptz,
    return_kind       text,
    actual_minutes    numeric,
    expected_minutes  numeric,
    tolerance_minutes integer,
    late_back         boolean
)
language plpgsql stable security definer set search_path = public
as $function$
begin
    -- [159-gate-wrapper] marker — do not remove; see the block above.

    -- Null org id: preserve the previous empty-result behaviour.
    if p_org_id is null then
        return;
    end if;

    -- The gate mirrors the access model the Timeclock page already
    -- implements client-side (timeclock.js: isAdminOrDev || isManager ||
    -- isClockViewer). The finding was that NOTHING enforced it server-side
    -- and the org id was unchecked — not that the model was wrong. All
    -- three helpers pin the caller to p_org_id, except is_admin_of, which
    -- also returns true for developers against any org (preserving the org
    -- switcher and PTL Clock's admin page).
    if not (public.is_admin_of(p_org_id)
            or public.user_is_dept_manager_in_org(p_org_id)
            or public.user_can_view_clock_comparison(p_org_id)) then
        raise exception 'not authorised';
    end if;

    -- No date-range validation here on purpose: PTL Clock's admin page
    -- drives this from free-form date pickers, and adding a cap would
    -- reject reports that work today. Authorisation only.
    return query
        select * from public._offsite_report_impl(p_org_id, p_start, p_end_excl, p_tz);
end$function$;

revoke all on function public._offsite_report(bigint, date, date, text) from public, anon;
grant execute on function public._offsite_report(bigint, date, date, text) to authenticated;

--------------------------------------------------------------------------------
-- VERIFICATION — run after applying, and after any PTL Clock deploy.
--
-- Expect FOUR rows: the two wrappers (has_gate = true) granted to
-- authenticated, and the two *_impl functions with NO authenticated grant.
-- If a wrapper shows has_gate = false, a Clock migration has clobbered it —
-- re-run this migration to repair (the Clock body is preserved).
--
--   select p.proname,
--          p.prosecdef,
--          pg_get_functiondef(p.oid) like '%[159-gate-wrapper]%' as has_gate,
--          array(select unnest(p.proacl)::text)                  as acl
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('org_live_status', '_org_live_status_impl',
--                        '_offsite_report', '_offsite_report_impl')
--    order by p.proname;
--
-- Then, as a PLAIN EMPLOYEE (no admins row, can_view_clock_comparison
-- false), both of these must now raise 'not authorised':
--
--   await sb.rpc("org_live_status", { p_org_id: 1 });
--   await sb.rpc("_offsite_report", { p_org_id: 1, p_start: "2026-08-01",
--                                     p_end_excl: "2026-08-08", p_tz: "Pacific/Auckland" });
--
-- And as an ADMIN, both must return exactly what they returned before:
--   - PTL Timesheet /timeclock.html   Live view + Off-site events tab
--   - PTL Clock     admin page        Live view + Off-site report, including
--                                     a date range wider than a year
--------------------------------------------------------------------------------
