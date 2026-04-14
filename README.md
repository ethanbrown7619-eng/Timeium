# Timeium — Timesheet module for Attendium

The timesheet / payroll / reporting module for the **Attendium** platform.
Pairs with the Attendium Phase-1 clock-in-out app on the same Supabase project
(`kyfydyownbgwhquorchn`) — shared multi-tenant schema, shared auth, shared
`organisations`, `users`, and `admins` tables.

> **Brand:** user-facing copy says **"Attendium"**. Internal names (repo,
> tables, RPCs, Cloudflare project) keep their original identifiers to avoid
> breaking deployments.

## Status

**Shipping one reviewable unit at a time.** Current unit on this branch:

### ✅ Unit 1 — Departments & Projects scaffolding

- `supabase/migrations/017_departments_and_projects.sql`
  - `departments` table, org-scoped, RLS via `is_admin_of(organisation_id)`
  - `projects` table, org-scoped, RLS via `is_admin_of(organisation_id)`
  - `upsert_projects_from_infusion(p_org_id, p_projects)` RPC (uses
    `resolve_org_id`)
  - Backfill: distinct free-text `users.department` values seeded into
    `departments` per org
- `supabase/functions/sync-infusion-projects/` — edge function that fans out
  across every active organisation, or targets one on demand
- `public/admin.html` — Departments CRUD for the current org, with developer
  org switcher

### ⏭ Later units (not yet built)

- `tasks`, `holidays` (+ admin UI)
- Employee auth linkage (`users.auth_user_id`) + sign-in page
- `timesheet_submissions`, `timesheet_entries` + weekly grid UI for employees
- "Manager" role on `admins` + approval dashboard (`is_manager_of(org)` helper)
- IMS + Infusion report exports
- Monday-8am deadline reminders edge function

## Conventions (from Attendium Phase 1)

- **Multi-tenancy:** every new table has `organisation_id bigint NOT NULL
  REFERENCES public.organisations(id) ON DELETE CASCADE`, indexed on
  `(organisation_id)`.
- **RLS:** `USING (public.is_admin_of(organisation_id))` with unqualified
  column names. No table aliases inside policy expressions.
- **RPCs:** every RPC that touches org-scoped data calls
  `public.resolve_org_id(p_org_id)` first. Never trust a client-supplied
  `organisation_id` for admin operations.
- **Migrations:** live in `supabase/migrations/NNN_*.sql`, sequentially
  numbered starting at **017** for this module. Idempotent
  (`create or replace`, `drop … if exists`, `on conflict do nothing`).
- **Destructive SQL** inside `SECURITY DEFINER` functions includes
  `WHERE true` to satisfy Supabase's safety check.

## Deployment

### Database

Run migration `017_departments_and_projects.sql` in the Supabase SQL editor.
Safe to re-run.

### Edge function

```bash
supabase functions deploy sync-infusion-projects \
  --project-ref kyfydyownbgwhquorchn

supabase secrets set \
  INFUSION_API_URL=<your Infusion projects endpoint> \
  INFUSION_API_KEY=<your Infusion API key> \
  --project-ref kyfydyownbgwhquorchn
```

Schedule a cron row (see `supabase/functions/sync-infusion-projects/README.md`)
for every 30 min. If Infusion creds aren't set yet, skip the secret step —
the admin Departments UI doesn't need them, and the test-mode `{ org_id,
projects }` invocation still works for local seeding.

### Web app

Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in `wrangler.toml` (same values as
the Attendium clock app), then:

```bash
npm install
npx wrangler deploy
```

The worker serves `public/` and exposes `/config.json` so the browser can
bootstrap Supabase without hard-coding keys.

## Repository layout

```
public/
  index.html             # redirects to /admin.html or /signup.html
  admin.html             # Departments CRUD (this unit)
  css/style.css
  js/
    admin.js             # Departments logic + developer org switcher
    shared.js            # notice(), escapeHtml()
    supabase-client.js   # lazy loads /config.json + createClient()
worker.js                # Cloudflare Worker entry
wrangler.toml

supabase/
  migrations/
    017_departments_and_projects.sql
  functions/
    sync-infusion-projects/
      index.ts
      README.md
```
