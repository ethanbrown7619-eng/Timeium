# PTL Timesheet

The timesheet, approval, and payroll-reporting app for PTL. Runs on its own,
or alongside [Attendium](https://github.com/ethanbrown7619-eng/Clock-in-out)
(the clock-in/out kiosk) when both products share a single Supabase project.

> **Brand:** user-facing copy says **"PTL Timesheet"**. The repo, Cloudflare
> worker, and `package.json` keep the original `timeium` identifier to avoid
> breaking deployments and migrations.

## Architecture

**Shared Supabase project.** This app and Attendium share the multi-tenant
core tables (`organisations`, `users`, `admins`, `app_settings`,
`pending_notifications`) and helpers (`is_admin`, `is_admin_of`,
`is_developer`, `resolve_org_id`). PTL Timesheet adds `is_manager_of`, a
`user_is_dept_manager_in_org` helper, and a handful of employee-login columns
on `users`.

| Deployment scenario | What works |
|---|---|
| **PTL Timesheet + Attendium on one Supabase** | Single login, single user roster. The clock-comparison view consumes Attendium's `weekly_timesheet` RPC. |
| **Attendium alone** | Unaffected. PTL Timesheet's migrations just aren't applied. |
| **PTL Timesheet alone (separate Supabase project)** | Requires running Attendium's migrations 001–021 first as a prerequisite bootstrap. PTL Timesheet's migrations (022+) assume that foundation. |

## Roles

| Role | How it's identified | UI access |
|---|---|---|
| **Employee** | `users` row with `auth_user_id = auth.uid()`; no `admins` row | Own timesheet + archive |
| **Department manager** | Employee with `users.is_manager = true`, set as `departments.manager_id` somewhere | Above + the My Departments dashboard for direct reports |
| **Manager** | `admins` row with `role='manager'` (org-level) | Above + leave approvals + cross-department visibility |
| **Admin** | `admins.role='admin'`; `organisation_id` set | Above + lookup CRUD + reports (scoped to their org) |
| **Developer** | `admins.role='developer'`; `organisation_id` NULL | Cross-org; can pick any org via the switcher |

## Features (current state)

- **Employee timesheet** (`/timesheet.html`)
  - Weekly grid editor with autocomplete on jobs / tasks / department codes
  - Browse-timesheets month calendar
  - Leave request form + balances
  - Public-holiday auto-fill
  - Submit + approval flow with status badges
- **Manager dashboard** (`/department.html`)
  - Donut charts per managed department
  - Approve / reject timesheets
  - Approve / reject / revoke leave requests
- **Read-only timesheet viewer** (`/timesheet-view.html`) — managers see an
  employee's submitted week before approving
- **Admin dashboard** (`/admin.html`)
  - Submission donut charts (employees + departments)
  - Clock-in vs timesheet comparison (via Attendium's `weekly_timesheet`)
  - Infusion XLSX export
  - Waged + salaried leave/overtime XLSX exports
  - Dev tools (test data generation, test-employee bulk delete)
- **Staff management** (`/staff.html`) — employees, departments,
  org-chart drag-drop, manager-assignment columns
- **Configuration** (`/configure.html`) — Jobs, Tasks, Department Codes
  (CRUD + bulk XLSX import), Public Holidays, organisation settings
- **Archive** (`/archive.html`) — past timesheets

## Conventions

- **Multi-tenancy:** every table carries
  `organisation_id bigint NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE`,
  indexed.
- **RLS:** `USING (public.is_admin_of(organisation_id))`. No aliases inside
  policy expressions.
- **RPCs:** every RPC that touches org-scoped data calls
  `public.resolve_org_id(p_org_id)` first. Never trust client-supplied
  `organisation_id`.
- **Migrations:** numbered sequentially starting at **022** for this app's
  own content (Attendium owns 001–021). Idempotent.
- **Schedules:** `cron.schedule()` via `pg_cron`.
- **Settings:** columns on `public.app_settings`, not a parallel table.
- **Destructive SQL** inside `SECURITY DEFINER` functions includes
  `WHERE true` to satisfy Supabase's safety check.

## Deployment

### 1. Database

In the Supabase SQL editor, apply each migration under `supabase/migrations/`
in order. They are all idempotent (re-running is safe). Latest in this branch:

- `053_manager_read_users.sql` — RLS policies allowing managers (admin role
  *and* department-lead `users.is_manager` flag) to read users in their
  organisation, so the manager dashboard sees their team.

### 2. Edge function (Infusion sync, optional)

```bash
supabase functions deploy sync-infusion-projects --project-ref <ref>

supabase secrets set \
  INFUSION_API_URL=<your Infusion projects endpoint> \
  INFUSION_API_KEY=<your Infusion API key> \
  --project-ref <ref>
```

### 2b. Edge function (email notifications)

`send-timesheet-notifications` is invoked every 15 minutes by `pg_cron`
(set up by migration `057_email_notification_cron.sql`). For each org it
checks whether the current local time matches the configured reminder /
overdue / discrepancy slot, then emails recipients via SMTP2GO.

```bash
supabase functions deploy send-timesheet-notifications --project-ref <ref>

supabase secrets set \
  SMTP2GO_API_KEY=<your SMTP2GO API key> \
  NOTIFY_FROM='PTL Timesheet <noreply@ptl.co.nz>' \
  APP_BASE_URL=https://<your-worker-domain> \
  --project-ref <ref>
```

The `SMTP2GO_API_KEY` is shared with Attendium's edge functions on the
same project; if it's already set, you only need `NOTIFY_FROM` (which
can use a different sender domain than Attendium's) and `APP_BASE_URL`
(used in the "Open my timesheet" links inside the email body).

After deploying, edit `supabase/migrations/057_email_notification_cron.sql`
to substitute `<YOUR-PROJECT-REF>` and `<YOUR-SERVICE-ROLE-JWT>`, then
apply it in the SQL editor. Smoke-test with:

```bash
curl -X POST https://<ref>.supabase.co/functions/v1/send-timesheet-notifications \
     -H "Authorization: Bearer <service-role-jwt>" \
     -H "Content-Type: application/json" \
     -d '{"force_org_id": 1, "force_kind": "reminder"}'
```

`force_kind` ∈ `'reminder' | 'reminder_2' | 'overdue' | 'discrepancy'`
bypasses the day/time check and dedup for that one org+kind.

### 3. Web app

`wrangler.toml` already contains the Supabase URL and anon key as `[vars]`.
The anon key is safe to commit — all destructive operations are gated by RLS
or SECURITY DEFINER RPCs.

```bash
npm install
npx wrangler deploy
```

The worker also enforces a Content-Security-Policy and the usual
hardening headers (HSTS, X-Frame-Options, X-Content-Type-Options,
Referrer-Policy, Permissions-Policy).

### 4. Sign in

Use an existing admin account from Attendium (its signup flow creates the
auth user + `admins` row). For a brand-new account, create it in
**Supabase → Authentication → Users → Add user**, then:

```sql
insert into public.admins (user_id, organisation_id, role)
values ('<auth-user-uuid>', 1, 'admin');
```

## Performance audit

A multi-batch performance + cleanup pass landed on this branch — see commit
history for `Batch 1` through `Batch 5`. Highlights:

- Auth role checks (3 queries) parallelised and cached for 5 minutes via
  `getUserContext()` in `shared.js` → eliminates ~3 round trips per
  navigation.
- XLSX (~600KB) is now lazy-loaded only when an Export button is clicked,
  not on every admin / configure page load.
- `loadLookups()` and `loadWeek()` in the timesheet editor parallelise
  their queries.
- The Browse Timesheets calendar caches per-month data for 60 seconds and
  invalidates on save / submit.
- Date helpers, donut SVG, status string constants, debounce, and
  request-deduplication (`makeLatestOnly`) are centralised in `shared.js`;
  duplicated copies removed from each page module.
- Worker hardened: fails fast on missing env vars; serves
  `/config.json` with `max-age=300` (was `no-store`); adds CSP + HSTS
  headers; redirects `/favicon.ico` to the SVG icon.

Items intentionally **not** addressed in this audit pass (low ROI for current
scale or large mechanical refactor):

- Event-delegation refactor of all row-button rendering (audit 3.4).
- Shared cache module for reference data (audit 3.7).
- In-place state updates instead of full reload after CRUD (audit 2.10).
- Move inline `<script type="module">` blocks to external files (audit 3.6;
  required to tighten CSP further by removing `'unsafe-inline'`).
- Test-data-generation server-side RPC (audit 1.6) — depends on DB work.
- Combining-RPC functions for hot paths (audit 5.2) — depends on DB work.
- RLS audit per audit 1.1 — must be done in the Supabase dashboard.
- Validating the `timesheet_entries_hours_nonneg` CHECK constraint added
  by migration 054 (audit pass #5, finding F4). The constraint is `NOT
  VALID` so new writes are guarded but legacy rows aren't. Before running
  `ALTER TABLE … VALIDATE CONSTRAINT`, run a one-off audit query to
  confirm no historical row violates it:
  ```sql
  select count(*) from public.timesheet_entries
   where mon_hours < 0 or tue_hours < 0 or wed_hours < 0
      or thu_hours < 0 or fri_hours < 0 or sat_hours < 0
      or sun_hours < 0;
  ```
  If the count is 0, run the validate. If non-zero, fix the rows first.

## Repository layout

```
public/
  index.html             router: signed in → /timesheet, else /signin
  signin.html            email+password sign in
  signup.html            employee self-signup (email-matched claim)
  forgot-password.html   reset link request
  reset-password.html    set new password from recovery link
  change-password.html   first-login forced password change
  welcome.html           landing for signed-in employees with no employee row
  timesheet.html         employee weekly grid + leave + calendar
  timesheet-view.html    read-only viewer for managers/admins
  archive.html           past timesheets
  department.html        manager dashboard (donuts + approvals)
  staff.html             employees + departments + org chart
  admin.html             org-wide dashboard, exports, dev tools
  configure.html         jobs / tasks / dept codes / holidays / org settings
  settings.html          per-user settings + change password
  favicon.svg
  config.json            static fallback for the worker's /config.json
  css/style.css
  js/
    admin.js
    archive.js
    configure.js
    department.js
    shared.js            shared helpers + auth context + dialogs
    staff.js
    supabase-client.js
    timesheet.js
    timesheet-view.js
worker.js                Cloudflare Worker (static + /config.json + CSP)
wrangler.toml

supabase/
  migrations/            022_… through 053_… (idempotent, in order)
  functions/
    sync-infusion-projects/
    send-timesheet-notifications/
```
