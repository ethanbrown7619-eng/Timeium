# Timeium — Timesheet Web App (Phase 2)

A lightweight web app that replaces the Excel-based timesheet process. Employees
fill in their weekly hours in a browser, managers approve, and Tina exports the
Infusion (project costs) and IMS (wages) reports for payroll.

**Pairs with** the Clock-in-out kiosk app
([ethanbrown7619-eng/Clock-in-out](https://github.com/ethanbrown7619-eng/Clock-in-out))
on the same Supabase project (`kyfydyownbgwhquorchn`). Everything shares a
single `public.users` roster, so clock totals can be compared against the hours
employees enter here.

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| DB / Auth | Supabase (Postgres) | Same project as the clock app |
| Frontend | Static HTML/CSS/JS in `public/` | No build step |
| Hosting | Cloudflare Workers (Assets) | `worker.js` serves `public/` + `/config.json` |
| Email | Supabase Edge Function + Resend | Reuses the clock app's `send-notifications` outbox |
| Infusion sync | Supabase Edge Function (`sync-infusion-projects`) | Runs every 30 min |

## Repository layout

```
public/                 # static web app (served by the Worker)
  index.html            # redirect to login or timesheet
  login.html
  timesheet.html        # employee — weekly grid, import last week, submit
  archive.html          # employee — history of submitted timesheets
  manager.html          # manager — pending approvals + missing submissions
  admin.html            # admin — employees, rates, departments, tasks, holidays, reports
  css/style.css
  js/
    supabase-client.js  # lazy-loads /config.json + createClient()
    shared.js           # auth gating, date helpers, CSV builder, topbar
    timesheet.js        # employee grid logic
    manager.js          # approval dashboard
    admin.js            # admin CRUD + report exports
worker.js               # Cloudflare Worker entry (static + /config.json)
wrangler.toml

supabase/
  migrations/
    011_timesheet_schema.sql   # new tables + users/admins/app_settings extensions
    012_timesheet_rpcs.sql     # save/submit/approve/reject/reopen + reports
    013_timesheet_rls.sql      # RLS policies for the new tables
  functions/
    sync-infusion-projects/    # edge function: Infusion → projects (cron ~30min)
    timesheet-deadline-reminders/  # edge function: enqueue Monday 8am reminders
```

Migrations are numbered starting at **011** because the clock app owns **001–010**.

## Feature checklist (from the project brief)

- [x] Browser-based timesheet entry
- [x] Hours cannot be entered without a job + project number + task (NOT NULL FKs)
- [x] Valid project numbers come from Infusion (`projects` table, 30-min sync)
- [x] Job description + status surfaced in the project dropdown
- [x] Department is a dropdown (`departments` table)
- [x] Task is a dropdown (`tasks` table)
- [x] Cost rate, sell rate, employee code stored on `users`; history tracked in `wage_rate_history`
- [x] >40h/week, weekends, and holidays are treated as overtime (server-side flag)
- [x] Warning when weekly total ≠ 40h before submit
- [x] Workflow: employee → manager → admin (Tina) for payment
- [x] Archive of sent timesheets (`/archive.html`)
- [x] Compare entered hours against clock hours (pre-fill + discrepancy highlight)
- [x] IMS + Infusion weekly CSV exports
- [x] Monday 8am deadline — reminder cron enqueues notifications for missing submissions + manager digests
- [x] Admin can reverse (reopen) any timesheet
- [x] "Import last week's tasks" prompt on a blank week (copies project/task rows, not hours)

Leave management is **Phase 3** and is intentionally not included here.

## Database integration points with the clock app

The clock app's `weekly_timesheet(week_start, tz)` RPC is consumed directly:
both `load_timesheet_week` (employee pre-fill + discrepancy reference) and the
manager dashboard use it so there's one source of truth for clock data.

`public.users` is extended here, not forked:

- `manager_id` — self-FK, used by the manager dashboard and reminder digest
- `auth_user_id` — links a Supabase-Auth login to an employee record
- `employment_type` — `waged` / `salaried` / `contractor` (used by the IMS filter)
- `overtime_threshold_hours` — per-employee override of `app_settings.overtime_threshold_hours`

`public.admins` accepts a new `role = 'manager'` value. A manager can read any
timesheet and approve/reject; they cannot change rates or run payroll unless
they also have `admin`.

`pending_notifications` is reused for:
- `timesheet_submitted` — fires at submission, lands in the manager's inbox
- `timesheet_approved` / `timesheet_rejected` — fires at manager decision
- `timesheet_reminder` — fires from the deadline cron
- `manager_missing_digest` — fires from the deadline cron

The email delivery pipeline (`send-notifications` function + Resend) already
drains this table; it does not need any changes.

## Local development

```bash
npm install                  # installs wrangler only
cp wrangler.toml wrangler.local.toml  # optional — edit vars locally
npm run dev                  # wrangler dev
```

Point `SUPABASE_URL` and `SUPABASE_ANON_KEY` at the same Supabase project used
by the clock app. They are safe to expose — every destructive write is gated
by RLS or a `SECURITY DEFINER` RPC that re-checks `auth.uid()`.

## Deployment

```bash
npx wrangler deploy
```

Apply DB migrations in order via the Supabase dashboard SQL editor, or with
`supabase db push` from a checkout that has `supabase/config.toml` set up.

Deploy edge functions:

```bash
supabase functions deploy sync-infusion-projects \
  --project-ref kyfydyownbgwhquorchn
supabase functions deploy timesheet-deadline-reminders \
  --project-ref kyfydyownbgwhquorchn
```

## Bootstrapping users

1. Create a Supabase Auth user (dashboard → Authentication → Add user).
2. Link it to an employee:
   ```sql
   update public.users
     set auth_user_id = '<auth-user-id>'
     where id = <employee-id>;
   ```
3. For managers, also add a row to `public.admins`:
   ```sql
   insert into public.admins (user_id, role)
     values ('<auth-user-id>', 'manager');
   ```

Admins (`role='admin'`) see the Admin nav item and can run report exports.
`role='developer'` is a strict superset of admin.

## Conventions followed from the clock app

- Week is Monday → Sunday; `week_start_of(date)` snaps to Monday.
- All timestamps stored in UTC (`timestamptz`); day bucketing uses
  `app_settings.timezone` via `AT TIME ZONE`.
- Destructive `DELETE` statements in SECURITY DEFINER functions include
  `WHERE true` to satisfy Supabase's safety check.
- CSV exports build client-side using `csvEscape` + `\n` newlines with
  filenames `{module}-{date}.csv`.
- Migrations are numbered sequentially; safe to re-run.
