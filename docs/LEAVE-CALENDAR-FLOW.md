# Leave → company calendar (Power Automate)

Approved leave in the Timesheet appears on the company calendar in Teams, and
follows the leave: a date change moves the event, and a cancellation or
rejection removes it. The database does the thinking (migration
`192_leave_calendar_sync.sql`). The flow only carries out what the database
tells it to.

```
every 15 min ─► leave_calendar_pending  ──►  for each op:
                (what's owed)                 create / update / delete the event
                                              └─► leave_calendar_ack (what happened)
```

## What goes on the calendar

- **Approved leave only.** Pending requests never appear.
- The subject is **"Jane Smith - On leave"**, plus "(4h/day)" for part days.
  The leave type and the reason are **never** shown, because sick leave on a
  company-wide calendar is a privacy problem. To change the wording, edit
  `public.leave_calendar_subject`. The next run updates every event.
- There is one all-day event per request, from the first to the last day,
  shown as **Free** with no reminder. A Fri–Mon request shows across the
  weekend.
- The first run adds leave **ending today or later**. Past leave is not
  back-filled.

## One-time setup

### 1. Apply migration 192

Paste `supabase/migrations/192_leave_calendar_sync.sql` into the Supabase SQL
editor (Sydney). Check it with `docs/CHECK-MIGRATIONS-APPLIED.sql`.

### 2. Mint the key (SQL editor)

`rotate_import_key` can't run in the SQL editor, because it needs a signed-in
admin. Insert the key directly instead:

```sql
update public.org_secrets
   set leave_calendar_key = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
       updated_at = now()
 where organisation_id = 1
returning leave_calendar_key;
```

Copy the value into the flow (step 4). It is a secret: anyone holding it can
see who is on leave and when.

### 3. Find the calendar

**A Teams channel calendar** is the calendar of the team's Microsoft 365
group. You need the group's **id**:
- In Teams, open the team, click **…**, then **Get link to team**. The link
  contains `groupId=<guid>`.
- Or, in a flow, the Office 365 Groups action "List groups I own".

The person whose account the flow runs under must be a **member** of that team.

**A shared mailbox calendar** (e.g. "PTL Company Calendar") also works. Use
`users/<mailbox address>` wherever the steps below say `groups/<group-id>`,
and use the **Office 365 Outlook** connector's "Send an HTTP request" instead
of the Groups one. The flow account needs Editor rights on that calendar.

### 4. Build the flow

This needs the premium **HTTP** action, the same one the Infusion feeds already
use. Every call to Supabase uses the same three headers:

| Header | Value |
|---|---|
| `apikey` | the Supabase **anon** key (same as the Infusion flows) |
| `Authorization` | `Bearer <anon key>` |
| `Content-Type` | `application/json` |

1. **Trigger: Recurrence**, every 15 minutes.
   - Under Settings, turn **Concurrency control on, degree 1**. Two overlapping
     runs would create the same event twice.
2. **HTTP: Get owed**
   - `POST https://swpxduxnjimsxtfpyxur.supabase.co/rest/v1/rpc/leave_calendar_pending`
   - Body: `{ "p_api_key": "<key from step 2>" }`
3. **Apply to each**, over `body('Get_owed')?['ops']`.
   - Under Settings, set **Concurrency control on, degree 1**.
4. Inside the loop, add a **Switch** on `items('Apply_to_each')?['op']`.

   **Case `create`:** Office 365 Groups, **Send an HTTP request**
   - Method `POST`
   - URI `https://graph.microsoft.com/v1.0/groups/<group-id>/events`
   - Body `items('Apply_to_each')?['graph_body']`

   **Case `update`:** Send an HTTP request
   - Method `PATCH`
   - URI `https://graph.microsoft.com/v1.0/groups/<group-id>/events/@{items('Apply_to_each')?['event_id']}`
   - Body `items('Apply_to_each')?['graph_body']`

   **Case `delete`:** Send an HTTP request
   - Method `DELETE`
   - URI as for update, with no body

5. **After the Switch, add the success report.** An HTTP action, **Ack ok**:
   - `POST .../rest/v1/rpc/leave_calendar_ack`
   - Body:
     ```
     {
       "p_api_key": "<key>",
       "p_results": @{setProperty(setProperty(items('Apply_to_each'), 'ok', true),
                       'event_id', coalesce(body('Create_event')?['id'], items('Apply_to_each')?['event_id']))}
     }
     ```
     (`Create_event` is whatever you named the create action.)

6. **Add the failure report.** A second HTTP action, **Ack failed**, beside
   **Ack ok**.
   - Under **Configure run after**, tick **has failed** only.
   - Body:
     ```
     {
       "p_api_key": "<key>",
       "p_results": @{setProperty(setProperty(items('Apply_to_each'), 'ok', false),
                       'error', string(outputs('Switch')))}
     }
     ```
   - The text only needs to contain `404` or `ErrorItemNotFound` when an event
     was deleted by hand. The database then treats a delete as done and
     re-creates an event whose update failed that way.

The first run creates every current and future approved leave. After that,
each run does only what has changed.

## Looking after it

- **Something didn't appear.** `leave_calendar_pending` returns `stuck`, the
  number of ops that failed 5 times and are no longer retried. Look at them,
  then re-queue them:
  ```sql
  select * from public.leave_calendar_events where error_count >= 5;
  update public.leave_calendar_events set error_count = 0 where error_count >= 5;
  ```
- **Someone edited or deleted an event by hand.** Edits are overwritten only
  when the leave itself changes. Deletes heal themselves on the next change.
  Change leave in the Timesheet, never on the calendar.
- **Start again from scratch.** Delete the events on the calendar, then
  `delete from public.leave_calendar_events;`. The next run re-creates every
  current and future leave.
- **Rotating the key.** Re-run step 2 and paste the new value into the flow's
  HTTP actions.
