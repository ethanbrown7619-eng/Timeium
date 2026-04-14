# timesheet-deadline-reminders

Runs on a cron schedule (e.g. Sunday 18:00 and Monday 07:00) and enqueues:

- One `timesheet_reminder` notification for every active employee with no
  submitted timesheet for last week.
- One `manager_missing_digest` notification per manager, listing their team
  members who haven't submitted.

Both notifications land in `public.pending_notifications` and are delivered by
the existing `send-notifications` function (maintained in the Clock-in-out
repo) via Resend.

## Deploy

```bash
supabase functions deploy timesheet-deadline-reminders \
  --project-ref kyfydyownbgwhquorchn
```

## Schedule

Cron rows in `cron.job` (Supabase dashboard → Database → Cron Jobs):

```
0 18 * * 0   -- Sunday evening nudge
0 7  * * 1   -- Monday morning last-chance (deadline is 8am)
```

Each row should `net.http_post` the function URL with the service-role key.
