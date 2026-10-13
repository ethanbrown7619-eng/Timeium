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
- **Weekends are left off** (migration 194). Each unbroken Mon–Fri stretch
  of a request is one all-day event, shown as **Free** with no reminder:
  Mon 12 – Mon 19 Oct shows as Mon 12 – Fri 16 plus Mon 19. Leave falling
  only on a Saturday and Sunday shows nothing. Public holidays are not
  skipped.
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
use. Name the actions **exactly** as written in bold below, because the
expressions refer to them by name. In an expression, a space in an action's
name becomes `_`.

Every HTTP call to Supabase uses the same three headers:

| Header | Value |
|---|---|
| `apikey` | the Supabase **anon** key (copy it from an Infusion flow) |
| `Authorization` | `Bearer <anon key>` |
| `Content-Type` | `application/json` |

**1. Create the flow.**
- In Power Automate, go to **Create** and choose **Scheduled cloud flow**.
- Name it `Leave to company calendar`, set it to repeat every **15 minutes**,
  and click **Create**.
- On the **Recurrence** trigger, open **Settings** and turn **Concurrency
  control on**, with degree of parallelism **1**.

**2. Add Initialize variable.**
- Name `eventId`, type **String**, value left empty.

**3. Add HTTP, renamed to Get owed.**
- Method `POST`
- URI `https://swpxduxnjimsxtfpyxur.supabase.co/rest/v1/rpc/leave_calendar_pending`
- The three headers above
- Body:
  `{ "p_api_key": "<key from step 2>", "p_limit": 1 }`
- `p_limit: 1` is only for the **first test**. It processes a single event.
  Remove it once the test event looks right.

**4. Add Apply to each, renamed to For each op.**
- Output from previous steps (expression): `body('Get_owed')?['ops']`
- Under **Settings**, turn **Concurrency control on**, degree **1**.

Every remaining step goes **inside** For each op.

**5. Add Set variable.**
- `eventId`, set to the expression `coalesce(item()?['event_id'], '')`.

**6. Add a Scope, renamed to Do op.** Inside it, add a **Switch**.
- On: the expression `item()?['op']`

**Case 1: equals `create`**
- Add **Office 365 Groups → Send an HTTP request** and rename it to
  **Create event**.
  - URI `https://graph.microsoft.com/v1.0/groups/<group-id>/events`
  - Method `POST`
  - Body: the expression `item()?['graph_body']`
- Below it, add **Set variable**: `eventId` = `body('Create_event')?['id']`

**Case 2: equals `update`**
- Add **Send an HTTP request**.
  - URI `https://graph.microsoft.com/v1.0/groups/<group-id>/events/` followed
    by the expression `item()?['event_id']`
  - Method `PATCH`
  - Body: the expression `item()?['graph_body']`

**Case 3: equals `delete`**
- Add **Send an HTTP request**.
  - URI the same as update
  - Method `DELETE`
  - No body

**7. Add HTTP, renamed to Ack ok.** It goes below the Do op scope and inside
the loop.
- Method `POST`
- URI `https://swpxduxnjimsxtfpyxur.supabase.co/rest/v1/rpc/leave_calendar_ack`
- The three headers
- Body: type the outer JSON, and insert the value of `p_results` as an
  expression:
  ```
  {
    "p_api_key": "<key>",
    "p_results": setProperty(setProperty(item(), 'ok', true), 'event_id', variables('eventId'))
  }
  ```

**8. Add HTTP, renamed to Ack failed.** Add it **in parallel** with Ack ok
(the **+** on the arrow, then **Add a parallel branch**).
- Same URI and headers as Ack ok.
- Body:
  ```
  {
    "p_api_key": "<key>",
    "p_results": setProperty(setProperty(item(), 'ok', false), 'error', string(result('Do_op')))
  }
  ```
- Open its **Settings** (or **Configure run after**). Untick **is
  successful**, then tick **has failed** and **has timed out**.
- `result('Do_op')` carries the Graph error. When it contains `404` or
  `ErrorItemNotFound` (an event someone deleted by hand), the database treats a
  delete as done and re-creates the event on an update.

**9. Save, then click Test → Manually.**
- With `p_limit: 1`, a single event should appear on the calendar.
- Check the following:
  - The event is all-day, covers the right dates and has the subject
    "Name - On leave".
  - **Group members did not each get an invite in their inbox.** If they did,
    turn off the group's "send copies of group events to members' inboxes"
    setting, or use a shared mailbox calendar instead.
  - In Supabase, `select * from public.leave_calendar_events;` shows one row
    with an `event_id`.

**10. Remove `"p_limit": 1` from Get owed and save.**
- The next run creates every current and future approved leave (up to 100
  per run).
- After that, each run does only what has changed.

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
