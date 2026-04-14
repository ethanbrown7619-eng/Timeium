# Temporium

The timesheet, approval, and payroll-reporting app for PTL. Built to run on
its own, or alongside [Attendium](https://github.com/ethanbrown7619-eng/Clock-in-out)
(the clock-in/out kiosk) when both products are deployed to the same Supabase
project.

> **Brand:** user-facing copy says **"Temporium"**. The repo, Cloudflare
> project, and internal table names keep their original identifiers
> (`Timeium`) to avoid breaking deployments.

## Architecture

**Option B (shared Supabase project).** Temporium and Attendium share the core
multi-tenant tables — `organisations`, `users`, `admins`, `app_settings`,
`pending_notifications` — plus the role helpers `is_admin`, `is_admin_of`,
`is_developer`, `resolve_org_id`. Temporium adds `is_manager_of` and a handful
of employee-login columns on `users`.

| Deployment scenario | What works |
|---|---|
| **Temporium + Attendium on one Supabase** | Single login, single user roster. Temporium can consume Attendium's `weekly_timesheet` RPC for clock-hour pre-fill and discrepancy highlighting. |
| **Attendium alone** | Unaffected. Temporium's migrations just aren't applied. |
| **Temporium alone (separate Supabase project)** | Requires running Attendium's migrations 001–021 first as a prerequisite bootstrap. Temporium's migrations (022+) assume that foundation. A future migration will extract a standalone `000_core.sql` when a real standalone install is on the horizon. |

## Roles (four, not three)

| Role | How it's identified | UI access |
|---|---|---|
| **Employee** | `users` row with `auth_user_id = auth.uid()`; no `admins` row | Own timesheet + archive (future units) |
| **Manager** | Employee + `admins` row with `role='manager'` | Above + approve timesheets for direct reports (future unit) |
| **Admin** | `admins.role='admin'`; `organisation_id` set | Above + lookup CRUD + reports (scoped to their org) |
| **Developer** | `admins.role='developer'`; `organisation_id` NULL | Cross-org; can pick any org via the switcher |

`admins.role`'s check constraint is widened in migration 022 to accept
`manager` — Attendium is unaffected because it never inserts that value.

## Status

**Shipping one reviewable unit at a time.** Current unit on this branch:

### ✅ Unit 1 — Departments & Projects scaffolding

- `supabase/migrations/022_temporium_core_extensions.sql`
  - Widens `admins_role_check` to include `manager`
  - Adds `is_manager_of(bigint)` and `current_user_employee()` helpers
  - Adds `users.auth_user_id` (employee login linkage)
  - Adds `users.manager_id` (self-FK), `users.employment_type`,
    `users.overtime_threshold_hours`
- `supabase/migrations/023_departments_and_projects.sql`
  - `departments` table, org-scoped, RLS via `is_admin_of(organisation_id)`
    with `members read` policy for employees + admins + developers in-org
  - `projects` table, org-scoped, RLS via `is_admin_of`
  - `upsert_projects_from_infusion(p_org_id, p_projects)` RPC via
    `resolve_org_id`
  - Backfill: distinct free-text `users.department` values seeded into
    `departments` per org
- `supabase/functions/sync-infusion-projects/` — multi-tenant edge function
  (fan-out across active orgs, or target one, or test-seed)
- `public/admin.html` — Departments CRUD for the current org, with developer
  org switcher; role-aware UI (manager sees read-only)

### ⏭ Later units (not yet built)

- Tasks + holidays (admin UI + migrations)
- Employee auth linkage + sign-in page
- `timesheet_submissions` + `timesheet_entries` + weekly grid UI for employees
- Approval dashboard for managers; email notifications via Attendium's
  `pending_notifications` outbox
- IMS + Infusion weekly CSV exports (`admin.html` "Custom report" pattern)
- Monday-8am deadline reminders (`pg_cron` + edge function enqueues into
  `pending_notifications`)

## Conventions (from Attendium Phase 1)

- **Multi-tenancy:** every new table carries
  `organisation_id bigint NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE`,
  indexed.
- **RLS:** `USING (public.is_admin_of(organisation_id))` with unqualified
  column names. No aliases inside policy expressions.
- **RPCs:** every RPC that touches org-scoped data calls
  `public.resolve_org_id(p_org_id)` first. Never trust a client-supplied
  `organisation_id` for admin operations.
- **Migrations:** numbered sequentially starting at **022** for Temporium's
  own content (Attendium owns 001–021). Idempotent (`create or replace`,
  `drop … if exists`, `on conflict do nothing`, `add column if not exists`).
- **Schedules:** use `cron.schedule()` — the same `pg_cron` mechanism
  Attendium introduced for `close_all_stale_shifts`.
- **Settings:** add columns to `public.app_settings`, not a parallel table.
- **Colour conventions:** flag badges reuse Attendium's `red` (short day) /
  `yellow` (auto-closed) text values. Don't introduce new ones for the same
  concepts.
- **Clock vs. timesheet hours:** intentionally different. The clock's
  `weekly_timesheet.hours` is `last_out − first_in − breaks`; Temporium's
  submission totals are sums of interval entries. The timesheet page shows
  clock hours as a *reference*, not a reconciliation target.
- **Destructive SQL** inside `SECURITY DEFINER` functions includes
  `WHERE true` to satisfy Supabase's safety check.

## Deployment

### 1. Database

In the Supabase SQL editor (project `kyfydyownbgwhquorchn`, same as Attendium):

```sql
-- Apply in order. Both are idempotent.
\i supabase/migrations/022_temporium_core_extensions.sql
\i supabase/migrations/023_departments_and_projects.sql
```

Or paste each file's contents into a SQL query and Run. Safe to re-run.

### 2. Edge function (optional this unit)

```bash
supabase functions deploy sync-infusion-projects \
  --project-ref kyfydyownbgwhquorchn

supabase secrets set \
  INFUSION_API_URL=<your Infusion projects endpoint> \
  INFUSION_API_KEY=<your Infusion API key> \
  --project-ref kyfydyownbgwhquorchn
```

Schedule the 30-minute sync — see
[`supabase/functions/sync-infusion-projects/README.md`](./supabase/functions/sync-infusion-projects/README.md).
If Infusion creds aren't set yet, the admin Departments page doesn't need
them; projects will stay empty until the function runs.

### 3. Web app

1. Fill in `wrangler.toml`:

   ```toml
   [vars]
   SUPABASE_URL = "https://kyfydyownbgwhquorchn.supabase.co"
   SUPABASE_ANON_KEY = "<anon key from Supabase → Project Settings → API>"
   ```

   Both values are safe to commit — all destructive operations are gated by
   RLS or `SECURITY DEFINER` RPCs.

2. Deploy:

   ```bash
   npm install
   npx wrangler deploy
   ```

   Cloudflare prints the live URL (something like
   `timeium.ethanbrown7619.workers.dev`).

### 4. Sign in

Temporium doesn't ship its own signup page in Unit 1. Use an existing admin
account from Attendium (its signup flow at `/signup.html` on the Attendium
worker creates the auth user + `admins` row). When you visit Temporium's
`/admin.html`, that session is recognised because both products share the
same Supabase auth.

If you need a brand-new account solely for Temporium testing, create it in
**Supabase → Authentication → Users → Add user**, then:

```sql
-- Link the new auth user to an organisation as an admin.
insert into public.admins (user_id, organisation_id, role)
values ('<auth-user-uuid>', 1, 'admin');  -- org 1 = PTL
```

## Repository layout

```
public/
  index.html             # bounces to /admin.html
  admin.html             # Departments CRUD (this unit)
  css/style.css
  js/
    admin.js             # role-aware Departments logic + developer org switcher
    shared.js            # notice(), escapeHtml()
    supabase-client.js   # lazy loads /config.json + createClient()
worker.js                # Cloudflare Worker (static + /config.json)
wrangler.toml

supabase/
  migrations/
    022_temporium_core_extensions.sql
    023_departments_and_projects.sql
  functions/
    sync-infusion-projects/
      index.ts
      README.md
```
