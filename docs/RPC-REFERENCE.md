# Timeium — Database function & RPC reference

## Document control

| | |
|---|---|
| **Version** | 1.0 |
| **Last updated** | 2026-08-05 (generated from migrations up to 163) |
| **Owner** | Ethan Brown (GitHub [`ethanbrown7619-eng`](https://github.com/ethanbrown7619-eng)) |
| **Update rule** | **Change this file in the same commit as any migration that adds, replaces, or drops a function.** Because authorization is enforced in the database, this file is the app's authoritative security surface. |

Source of truth: `supabase/migrations/*.sql` (this repo owns numbers ≤ 199; 022–030
predate the split but live here). `schema-replica.sql` was used only as a cross-check —
it is a snapshot and is stale in places (e.g. it shows an old `record_login_attempt`
signature and lacks `clock_view_scope`); where they differ, the migration wins.

Shorthand used below: **"Admin"** means `public.is_admin_of(org)` → a row in
`public.admins` for `auth.uid()` with matching org (or `role='developer'`);
**"manages target"** means `public.user_manages_target_user(u)` → caller is
`departments.manager_id` for the target's department.

## Timesheets

| Function (signature) | Defined in | SECURITY | Who may call / auth check inside | Purpose | Called from |
|---|---|---|---|---|---|
| `get_or_create_timesheet(p_week_start date) → bigint` | 055 | DEFINER | Caller must have a `users` row (`auth_user_id = auth.uid()`); can only touch own timesheet | Race-free upsert of the caller's timesheet for a week | timesheet.js, admin.js |
| `admin_get_or_create_timesheet(p_user_id, p_week_start) → bigint` | 110 | DEFINER | `is_admin_of(target's org)` | Same upsert but for any employee (admin mode) | timesheet.js (dynamic `fn`) |
| `manager_get_or_create_timesheet(p_user_id, p_week_start) → bigint` | 118 | DEFINER | `user_manages_target_user(p_user_id)` | Same upsert for a managed employee | timesheet.js (dynamic `fn`) |
| `import_last_week_tasks(p_week_start date) → int` | 055 | DEFINER | Caller must have a `users` row; operates only on own timesheets | Copy previous week's entry rows (no hours) into current week | timesheet.js |
| `duplicate_timesheet_entry(p_entry_id bigint) → timesheet_entries` | 120 | **INVOKER** | None in body — relies on `timesheet_entries` RLS | Clone an entry row below the original, shifting sort_order | timesheet.js |
| `snapshot_timesheet_job_statuses(p_timesheet_id) → void` | 032 | DEFINER | **None in body** — granted to authenticated; only writes where `job_status_snapshot is null` | Stamp each entry with its job's status at submit time | timesheet.js |
| `admin_submit_timesheet(p_timesheet_id) → void` | 123 (grew from 115/116/119) | DEFINER | `is_admin_of(org)` OR `user_manages_target_user(owner)`; status must be draft/rejected; validates every hour-bearing non-leave row has job + dept (+ task if dept requires) | Submit a timesheet on the employee's behalf | timesheet-view.js |
| `reset_to_approved(p_timesheet_id) → bool` | 109 | DEFINER | `is_developer()` only; status must be `exported` | Roll an exported timesheet back to approved (re-export) | staff.js |

## Leave

| Function (signature) | Defined in | SECURITY | Who may call / auth check inside | Purpose | Called from |
|---|---|---|---|---|---|
| `submit_leave_request(p_leave_type_id, p_start_date, p_end_date, p_hours_per_day num=8, p_skip_weekends bool=true, p_reason text=null) → bigint` | 150 | DEFINER | Caller must have a `users` row; creates for self only; validates dates/hours | Employee raises leave → status `pending_manager` | leave.js |
| `submit_leave_request_on_behalf(p_user_id, + same args) → bigint` | 150 | DEFINER | Admin of target's org OR manages target; caller must be on roster; blocked for own leave | Manager/admin proposes leave → `pending_employee` | leave.js |
| `accept_leave_request(p_request_id) → void` | 150 | DEFINER | Caller must be the employee the request is for; status `pending_employee` | Employee accepts proposed leave; populates timesheet, marks approved | leave.js |
| `decline_leave_request(p_request_id, p_note=null) → void` | 150 | DEFINER | Caller must be the employee; status `pending_employee` | Employee declines proposed leave → cancelled | leave.js |
| `update_pending_leave_request(p_request_id, p_leave_type_id, p_start_date, p_end_date, p_hours_per_day, p_skip_weekends, p_reason=null) → void` | 155 | DEFINER | Admin OR manages target; status `pending_employee` only | Edit a still-unaccepted on-behalf request | leave.js |
| `cancel_pending_leave_request(p_request_id, p_note=null) → void` | 155 | DEFINER | Admin OR manages target; status `pending_employee` | Withdraw an on-behalf request | leave.js |
| `manager_approve_leave_request(p_request_id, p_note=null) → void` | 150 | DEFINER | Delegates entirely to `approve_leave_request` | Manager final-approval wrapper (kept for UI compat) | leave.js |
| `manager_reject_leave_request(p_request_id, p_note=null) → void` | 126 | DEFINER | Admin OR manages target; status `pending_manager` | Manager rejects at first stage | leave.js |
| `approve_leave_request(p_request_id, p_note=null) → void` | **150** (supersedes 126/129/131/133/042/054) | DEFINER | Admin OR manages target; status `pending_manager`/`pending_admin`; calls `populate_timesheet_for_leave` | Final approval; writes leave hours into timesheets | admin.js |
| `reject_leave_request(p_request_id, p_note=null) → void` | 126 | DEFINER | `is_admin_of(org)` only; status pending | Admin rejects a pending request | admin.js |
| `cancel_leave_request(p_request_id) → void` | 128 | DEFINER | Caller must be the requesting employee; status pending | Employee cancels own pending request | leave.js |
| `revoke_leave_request(p_request_id, p_note=null) → void` | **152** (supersedes 136/043) | DEFINER | Admin OR manages target; status `approved` | Revoke approved leave; zeroes/deletes the populated timesheet hours | admin.js, leave.js |
| `request_leave_change(p_request_id, p_type 'cancel'\|'amend', p_note=null) → void` | 136 | DEFINER | Caller must be the employee; status `approved` | Employee flags approved leave for cancel/amend | leave.js |
| `request_leave_amendment(p_request_id, p_leave_type_id, p_start_date, p_end_date, p_hours_per_day, p_skip_weekends, p_reason=null) → void` | 138 | DEFINER | Caller must be the employee; status `approved`; validates values | Employee proposes concrete new values for approved leave | leave.js |
| `apply_leave_amendment(p_request_id) → void` | **152** (supersedes 138) | DEFINER | Admin OR manages target; requires a pending `amend` proposal | Strip old hours, overwrite request with proposed values, re-populate timesheet | admin.js, leave.js |
| `dismiss_leave_change_request(p_request_id) → void` | **152** (supersedes 136) | DEFINER | Admin OR manages target | Clear a change-request flag without acting | admin.js, leave.js |
| `dismiss_my_leave_request(p_request_id) → void` | 157 | DEFINER | Caller must be the employee; status rejected/cancelled | Hide a finished request from the employee's list | leave.js |
| `list_team_leave_requests(p_org_id, p_status) → table` | **155** (supersedes 135/130) | DEFINER | Row-filtered inside query: admin OR manages that row's user | List requests of a given status for the caller's team/org | leave.js |
| `list_team_leave_change_requests(p_org_id) → table` | 152 | DEFINER | Same row filter: admin OR manages row's user | List approved leave with pending change requests | leave.js |
| `list_managed_employees(p_org_id) → table(id,name)` | 150 | DEFINER | Row filter: admin sees all active, else only depts where caller is `manager_id`; excludes self | Populate the "on behalf of" picker | leave.js |
| `org_leave_calendar(p_org_id, p_from, p_to) → table` | 156 | DEFINER | Any roster member of the org, or admin/manager/developer | Approved-leave ranges for the org calendar | leave-calendar.js |
| `org_on_leave_today(p_org_id, p_today) → table` | 134 | DEFINER | Admin OR `is_manager_of` OR `can_view_clock_comparison` flag | Who is on approved leave today (Live view) | timeclock.js |
| `dev_delete_leave_request(p_request_id) → void` | 137 | DEFINER | `is_developer()` only | Hard-delete a request, stripping applied hours first | admin.js |
| `populate_timesheet_for_leave(p_request_id) → bool` | 150 | DEFINER | **EXECUTE revoked from public/anon/authenticated** — internal only | Shared engine that writes leave hours (false for unmapped types, e.g. Unpaid) | internal (approve/accept) |
| `apply_leave_to_timesheet(p_request_id) → void` | 055 | DEFINER | `is_manager_of(org)`; refuses if any touched week is submitted/approved; refuses zero-entry ranges | Legacy leave→timesheet writer | internal (`update_approved_leave_request`) |
| `clear_leave_from_timesheet(p_request_id) → void` | 055 | DEFINER | `is_manager_of(org)`; refuses if touched weeks locked | Legacy remover of populated leave hours | internal |
| `update_approved_leave_request(...7 args) → void` | 043 | DEFINER | `is_manager_of(org)`; status `approved` | Legacy edit-approved-leave (clear → update → re-apply) | not called from JS (legacy) |
| `seed_default_leave_types(p_org_id) → void` | **145** (supersedes 132/041) | DEFINER | **None in body** (idempotent `on conflict do nothing` insert) | Seed the NZ default leave-type set | internal / setup |

## Clock (this repo's side)

| Function (signature) | Defined in | SECURITY | Who may call / auth check inside | Purpose | Called from |
|---|---|---|---|---|---|
| `list_my_clock_events(p_start, p_end_excl timestamptz) → table` | 146 | DEFINER | Caller must have a `users` row; own events only | Employee's clock events + pending adjustment flags | myclock.js |
| `list_my_offsite_spells(p_start, p_end_excl timestamptz) → table` | 147 | DEFINER | Caller must have a `users` row; own spells only | Employee's off-site break/job spells with return times | myclock.js |
| `submit_clock_adjustment(p_clock_event_id, p_requested_time timestamptz, p_reason=null) → bigint` | 146 | DEFINER | Event must belong to caller; ±24 h window; one pending per event | Request a clock-time correction | myclock.js |
| `list_clock_adjustment_requests(p_org_id, p_status=null) → table` | 146 | DEFINER | Admin/developer, else `can_view_clock_comparison`; dept-scoped when `clock_view_scope <> 'all'` (144) | Review queue for clock adjustments | timeclock.js |
| `review_clock_adjustment(p_request_id, p_approve bool, p_note=null) → void` | 146 | DEFINER | Same rule as list, checked against the target's department; row-locked | Approve (rewrites `clock_events.occurred_at`) or decline | timeclock.js |
| `clock_auto_closed_days(p_org_id, p_start, p_end_excl date, p_tz=null) → table(user_id, day)` | 121 | DEFINER | Admin OR `can_view_clock_comparison` | Days containing auto-closed clock-outs (yellow flags) | timeclock.js |
| `clock_unpaid_breaks(p_org_id) → table` | 122 | DEFINER | Admin OR `can_view_clock_comparison` | Active unpaid break rules for comparison maths | timeclock.js |

## Admin / staff / reports

| Function (signature) | Defined in | SECURITY | Who may call / auth check inside | Purpose | Called from |
|---|---|---|---|---|---|
| `create_employee(p_org_id=null, p_name, p_email, p_department_id, p_cost_rate, p_sell_rate, p_employment_type='waged', p_employee_code, p_overtime_threshold_hours, p_receives_overtime=false) → users` | 106 | DEFINER | `resolve_org_id` (raises unless caller is an admin; devs may override org) | Create an employee row with fresh `qr_token` | staff.js |
| `provision_employee_login(p_user_id) → text` | **163** (supersedes 140/055/054/037/036) | DEFINER | `is_admin_of(employee's org)` | Create/link an `auth.users` account; returns random temp password (null if linked existing). **163 refuses to link an identity another `users` row already owns** (audit A9), backed by the `users_auth_user_id_uniq` index | staff.js |
| `reset_employee_password(p_user_id) → text` | **140** (supersedes 100) | DEFINER | `is_admin_of(org)`; account must exist | Set a new random temp password + `must_change_password` | staff.js |
| `gen_temp_password() → text` | 140 | DEFINER | none (pure generator) | 12-char random password helper | internal |
| `reset_org_hours(p_org_id) → int` | 100 | DEFINER | `is_admin_of(p_org_id)` | Delete ALL timesheets + entries for the org (dev tool) | admin.js |
| `reset_user_week(p_user_id, p_week_start) → int` | 103 | DEFINER | `is_developer()` only | Delete one user's week (bypasses status rules) | staff.js |
| `log_infusion_export(p_org_id, p_week_start, p_row_count) → bigint` | 124 | DEFINER | `is_admin_of(p_org_id)` | Record an Infusion CSV export event | admin.js |
| `infusion_export_row_counts(p_org_id, p_week_start) → table(already_exported, pending_approved)` | 125 | DEFINER | `is_admin_of(p_org_id)` | Pre-export counts (approved vs already exported day-rows) | admin.js |

## Org / config / integrations

| Function (signature) | Defined in | SECURITY | Who may call / auth check inside | Purpose | Called from |
|---|---|---|---|---|---|
| `save_org_settings(p_org_id, p_settings jsonb) → void` | **141** (supersedes 107/105/056/050/047) | DEFINER | `resolve_org_id` + `is_admin_of` | Patch org settings; SMTP/debug-redirect secrets now written to `org_secrets` | configure.js |
| `get_org_secrets_admin(p_org_id=null) → table` | 141 | DEFINER | `resolve_org_id` + `is_admin_of` | Read SMTP + webhook keys for the Configure page | configure.js |
| `rotate_import_key(p_kind 'jobs'\|'tasks'\|'dept_codes', p_org_id=null) → text` | **141** (supersedes 032/030) | DEFINER | `resolve_org_id` + `is_admin_of` | Mint a new webhook API key into `org_secrets` | configure.js |
| `save_import_mapping(p_kind, p_mapping jsonb, p_org_id=null) → void` | **032** (supersedes 030) | DEFINER | `resolve_org_id` + `is_admin_of` | Store CSV column/status mapping for webhook imports | configure.js |
| `ingest_jobs_via_webhook(p_api_key, p_rows jsonb) → jsonb` | **141** (supersedes 052/030) | DEFINER | API key (≥16 chars) must match `org_secrets.jobs_webhook_key` — no auth.uid() | Upsert jobs from the Infusion push | external webhook |
| `ingest_tasks_via_webhook(p_api_key, p_rows jsonb) → jsonb` | **141** (supersedes 052/030) | DEFINER | key vs `org_secrets.tasks_webhook_key` | Upsert tasks | external webhook |
| `ingest_dept_codes_via_webhook(p_api_key, p_rows jsonb) → jsonb` | **141** (supersedes 032) | DEFINER | key vs `org_secrets.dept_codes_webhook_key` | Upsert department codes | external webhook |
| `upsert_projects_from_infusion(p_org_id=null, p_projects jsonb) → int` | 023 | DEFINER | `resolve_org_id` (admin required) — edge fn calls with service key | Upsert Infusion projects | edge fn `sync-infusion-projects` |
| `suggest_jobs(p_query, p_limit=10, p_org_id=null) → table` | 030 | DEFINER | `resolve_org_id` (admin-only as written) | Job typeahead search | not called from JS currently |
| `seed_public_holidays_for_year(p_org_id, p_year) → int` | 045 | DEFINER | **None in body** (idempotent insert; uses `generate_nz_public_holidays`) | Seed NZ public holidays for a year | configure.js |
| `set_leave_type_job_mapping(p_leave_type_id, p_job_id) → void` | 131 | DEFINER | `is_admin_of(leave type's org)`; job must be same-org + `is_leave` | Map leave type → leave job (current direction) | configure.js |
| `set_job_leave_type_mapping(p_job_id, p_leave_type_id) → void` | 127 | DEFINER | `is_admin_of(job's org)`; job must be `is_leave` | Older inverse mapping | not called from JS (superseded by 131) |
| `xero_connection_status(p_org_id) → table` | 112 | DEFINER | `is_admin_of` | Show Xero connection details | configure.js |
| `xero_disconnect(p_org_id) → void` | 112 | DEFINER | `is_admin_of` | Delete the org's Xero connection | configure.js |
| `xero_set_employee_mapping(p_user_id, p_xero_employee_id text) → void` | 113 | DEFINER | `is_admin_of(user's org)` | Map employee → Xero employee id | configure.js |
| `xero_set_job_leave_type_mapping(p_job_id, p_xero_leave_type_id text) → void` | 114 | DEFINER | `is_admin_of`; job must be `is_leave` | Map leave job → Xero leave type | configure.js |
| `xero_set_leave_type_mapping(p_leave_type_id, p_xero_leave_type_id text) → void` | 113 | DEFINER | `is_admin_of` | Older leave-type→Xero mapping | not called from JS (superseded by 114) |
| `set_leave_notifications(p_org_id, p_enabled bool) → void` | 158 | DEFINER | `is_admin_of(p_org_id)` | Toggle `organisations.notify_leave` (dedicated setter — deliberately NOT folded into `save_org_settings`, whose live definition has drifted) | configure.js |

## Auth / misc

| Function (signature) | Defined in | SECURITY | Who may call / auth check inside | Purpose | Called from |
|---|---|---|---|---|---|
| `claim_employee_by_email() → jsonb` | 024 | DEFINER | Uses `auth.uid()`; links only an unclaimed `users` row whose email equals the auth email | First-login linking of auth account → employee row | shared.js, welcome.js |
| `clear_must_change_password() → void` | 111 | DEFINER | Own row only (`auth_user_id = auth.uid()`) | Clear the forced-change flag after password change | change-password.js, reset-password.js, settings.js |
| `check_login_locked(p_email) → bool` | **162** (supersedes 104) | DEFINER | none — public pre-login check (count-only, no data leak) | ≥5 failures in 15 min ⇒ locked. **Counts only `source='auth_hook'` rows**, so the anon endpoint cannot lock anyone out (audit A5). Returns false while the 142 hook is disabled | signin.js |
| `record_login_attempt(p_email, p_failure_reason=null, p_user_agent=null) → void` | **162** (supersedes 139/104) | DEFINER | none — insert-only (failures only) | Log a failed login as `source='client'` (forensics only, never drives the lockout). Capped at 20 rows per email per 15 min; over the cap it silently no-ops | signin.js |
| `record_login_success() → void` | **162** (supersedes 139) | DEFINER | Uses `auth.uid()`'s own email | Log a successful login as `source='session'` | signin.js |
| `password_verification_hook(event jsonb) → jsonb` | **162** (supersedes 142) | DEFINER | Called by Supabase Auth (hook), not clients | Server-side record of verification outcomes as `source='auth_hook'` + hard lockout (`decision: reject`). **Not enabled** — Team/Enterprise plan only | Supabase Auth hook |
| `prune_login_attempts() → integer` | **162** | DEFINER | revoked from all client roles | Delete `login_attempts` older than 180 days | pg_cron `prune-login-attempts`, 03:17 daily |
| `user_manages_target_user(p_user_id) → bool` | 102 | DEFINER | pure predicate on `auth.uid()` | "Does caller manage this employee's department?" — used by UI and inside many RPCs | timesheet.js, timesheet-view.js, internal, RLS |
| `is_manager_of(org_id) → bool` | 022 | DEFINER | predicate on `public.admins` (admin/manager/developer) | Role helper for RLS + RPC gates | internal / RLS |
| `current_user_employee() → bigint` | 022 | DEFINER | predicate | Caller's `users.id` | internal / RLS |
| `user_is_dept_manager_in_org(p_org_id) → bool` | 053 | DEFINER | predicate on `users.is_manager` | Department-lead role check, pinned to the org. **No longer used by any RLS policy** (160 re-keyed those on `user_manages_target_user`); it is now the department-lead branch of the gate in `org_live_status`, `_offsite_report` (159) and `clock_roster` (160). Do not drop | internal (RPC gates) |
| `user_can_view_clock_comparison(p_org_id) → bool` | 108 | DEFINER | predicate on `users.can_view_clock_comparison` | RLS/RPC helper for clock viewers | RLS, internal |

Helpers **not defined in this repo** but relied on everywhere: `is_admin()`,
`is_admin_of(org)`, `is_developer()`, `resolve_org_id(org?)` (shared core, present in
`schema-replica.sql`). `is_developer` is also called directly from shared.js and the
notifications edge function; `is_admin_of` is called from worker.js (`supabaseRpc`) for
route gating. `list_present_guests_admin(p_org_id)` is called from timeclock.js but is
owned by the separate Guest sign-in app (not in this repo's migrations or replica).

## Kiosk-owned functions — do not modify from this repo

Owned by the separate PTL Clock kiosk repo; signatures as they appear in
`schema-replica.sql` (the replica may lag the kiosk repo):

- `record_scan(p_qr_token text, p_device_token text, p_occurred_at timestamptz=null) → table(action, user_id, name, occurred_at, cooldown_seconds_remaining, breaks jsonb, current_status)` — DEFINER; authenticates by device token in `device_registrations` + user `qr_token`/`rfid_uid` (no auth.uid()). **kiosk-owned — do not modify** (note: migration 153 in this repo *did* touch its early-leave window; coordinate with the kiosk repo).
- `record_offsite_choice(p_user_id bigint, p_device_token text, p_choice text, p_break_id bigint=null, p_occurred_at timestamptz=null) → table(action, user_id, name, occurred_at)` — DEFINER; device-token auth. **kiosk-owned — do not modify**
- Auto-close family: `_close_stale_shifts_for_org(p_org_id)`, `close_stale_shifts(p_org_id=null)`, `close_all_stale_shifts()` (cron), `reset_clock_data(p_org_id=null)` (developer-gated). **kiosk-owned — do not modify**
- Device pairing: `create_pairing_code(p_org_id=null)`, `redeem_pairing_code(p_code, p_device_name=null)`, `list_devices(p_org_id=null)`, `revoke_device(p_device_id)`. **kiosk-owned — do not modify**
- `weekly_timesheet(p_week_start date, p_tz=null, p_org_id=null)` and `timesheet_for_range(p_start, p_end, p_tz=null, p_org_id=null)` — DEFINER wrappers over `_timesheet_rows`; weekly allows admins (via `resolve_org_id`) or `can_view_clock_comparison` users; range is admin-only, ≤365 days. Kiosk-owned but heavily consumed here (timeclock.js ×3, notifications edge function).
- `admin_add_clock_event` — named in the developer guide as kiosk-owned but **not present in schema-replica.sql**; treat as kiosk-repo-only.

## Shared / boundary functions (owned here, consumed by the kiosk)

Latest definitions live in THIS repo's migrations; the kiosk repo calls them.

> **Changed by migration 159 (security audit A2).** Two of these three previously
> had **no in-body auth check** while being granted to `authenticated` and taking
> a caller-supplied `p_org_id` — any signed-in user could read any organisation's
> clock data. They are now **gated wrappers** over renamed `*_impl` functions.
> Edit the `_impl`; never `create or replace` the public name from the kiosk repo
> or the gate is silently lost. See 159's header for the repair procedure.

- `org_live_status(p_org_id) → table(user_id, name, department, status, break_id, break_name, since)` — **gated wrapper, 159**. Gate: `is_admin_of` OR `user_is_dept_manager_in_org` OR `user_can_view_clock_comparison`, all pinned to `p_org_id`; null org returns zero rows. Delegates to `_org_live_status_impl`. Called from timeclock.js (Live tab) and the kiosk admin page.
- `_org_live_status_impl(p_org_id)` — the original body (latest **149**), renamed by 159. **No auth check by design**; revoked from `public`/`anon`/`authenticated` so only the wrapper reaches it.
- `_timesheet_rows(p_org_id, p_start, p_end_excl, p_tz) → table(..., hours, flag)` — latest in **149**; the whole clock-report engine (tolerance rounding, breaks, red/yellow/orange flags). No in-body auth check, but already revoked from `public`; reached via `weekly_timesheet`/`timesheet_for_range`.
- `_offsite_report(p_org_id, p_start, p_end_excl, p_tz) → table(...)` — **gated wrapper, 159**, same gate as above. Deliberately adds no date-range limit: the kiosk admin page drives it from free-form date pickers. Called directly from timeclock.js and the kiosk.
- `_offsite_report_impl(p_org_id, p_start, p_end_excl, p_tz)` — the original body (latest **151**, supersedes 149; suppresses false "clock out early" rows), renamed by 159. Revoked from all client roles.
- `clock_roster(p_org_id) → table(id, name, department_id, employment_type, active)` — **160**; DEFINER, same three-role gate. Org-wide display roster **with no rate columns**, added so the Timeclock page keeps working after 160 narrowed department-lead reads on `users`. Called from timeclock.js (live roster + managed-scope filter).

## Triggers

| Trigger | Table | Enforces | Migration |
|---|---|---|---|
| `trg_projects_updated_at` | `projects` | `set_updated_at()` — stamp `updated_at` on UPDATE | 023 |
| `trg_jobs_updated_at` / `trg_tasks_updated_at` | `jobs` / `tasks` | same | 030 |
| `trg_timesheets_updated_at` / `trg_timesheet_entries_updated_at` | `timesheets` / `timesheet_entries` | same | 031 |
| `trg_department_codes_updated_at` | `department_codes` | same | 032 |
| `trg_timesheet_require_department` | `timesheets` (BEFORE UPDATE OF status) | `check_timesheet_dept_on_submit()` — blocks transition to `submitted` while any hour-bearing non-leave entry lacks `dept_code_id` (backstop for the employee self-submit path, which is plain RLS UPDATE, not an RPC) | 148 |
| `trg_queue_leave_notification` | `leave_requests` (AFTER INSERT OR UPDATE) | `_queue_leave_notification()` (DEFINER) — when `organisations.notify_leave` is on, derives an event kind (submitted / on_behalf / accepted / declined / approved / rejected / cancelled / revoked / change_requested) from the status transition and appends to `leave_notification_queue`. The queue table is RLS-on with **no policies** (service-role only — invisible to clients); the send-timesheet-notifications edge function drains it, enforcing the future-dates rule at send time | 158 |

## Internal helpers (never called from JS, not SECURITY DEFINER)

- `_canonical_job_status(raw, status_map)` / `_canonical_task_status(...)` / `_canonical_dept_code_status(...)` (030/032, IMMUTABLE) — normalise webhook status strings to the allowed sets.
- `generate_nz_public_holidays(p_year) → table` (045, INVOKER) — computes NZ holidays incl. Easter, Mondayisation, gazetted Matariki 2022–2052.
- `set_updated_at()` (023) and `check_timesheet_dept_on_submit()` (148) — trigger functions, see table above.

## Notes for maintainers

1. Later migrations replace same-named functions in place; `create or replace`
   preserves grants, so the grant history (mostly `grant execute … to authenticated`,
   plus the explicit `revoke` on `populate_timesheet_for_leave` in 150) is what
   actually limits callers of the check-free functions.
2. Employee self-submit of timesheets is **not an RPC at all** — it's a direct
   RLS-governed `update … set status`, which is why trigger 148 exists.
3. `admins.user_id` is an auth UUID; `users.id` is the bigint employee id — the two
   role systems (`admins` roles vs `users.is_manager` / dept `manager_id`) are
   distinct, and both appear in auth checks.
