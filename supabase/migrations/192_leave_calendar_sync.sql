-- 192_leave_calendar_sync.sql - approved leave onto the company calendar.
--
-- The ask (2026-10-13): "an automation for the leave that people register to
-- write to the company calendar on teams" - built with Power Automate (user
-- decision; the Graph-from-our-own-code route needs a new tenant permission and
-- cannot write a Teams/group calendar app-only anyway).
--
-- PULL, not push. A Power Automate flow on a 15-minute Recurrence:
--
--   1. POST leave_calendar_pending(key)  -> the calendar operations owed
--   2. per op: create / update / delete the event (Office 365 Groups
--      "Send an HTTP request" for a Teams calendar, or the Outlook connector
--      for a shared mailbox) - each op carries a Graph-ready `graph_body`
--   3. per op: POST leave_calendar_ack(key, op + event_id / error)
--
-- Why pull: nothing in the database has to know the flow's URL (a signed
-- secret), a run that fails just leaves the work owed for the next one, and the
-- first run IS the backfill. The flow authenticates exactly like the Infusion
-- invoice feed: apikey + Bearer = the public anon key, the minted key in the
-- body (org_secrets.leave_calendar_key).
--
-- WHAT GOES ON THE CALENDAR (defaults - say the word to change them):
--   * approved requests only; pending ones never appear
--   * subject "<name> - On leave", plus "(4h/day)" when hours_per_day < 8.
--     NO leave type and NO reason: sick / bereavement leave is nobody's
--     business on a company-wide calendar. One function, leave_calendar_subject.
--   * one all-day event from start_date to end_date, shown as Free, no reminder
--   * creates only for leave ending today or later (NZ) - the first run does
--     not dump two years of history onto the calendar. Moves and deletes
--     still reach an event whose leave is in the past.
--
-- The sync is a DIFF between what should be on the calendar (approved leave)
-- and what we last put there (public.leave_calendar_events), so a date change
-- (an accepted change request) becomes an update, a cancellation or rejection
-- becomes a delete, and a renamed person updates their events.
--
-- No FK to leave_requests on purpose: a hard-deleted request must still be
-- able to delete its event.
--
-- An op that fails 5 times stops being offered (it would otherwise retry every
-- 15 minutes forever); `stuck` in the pending response counts them, and
--   update public.leave_calendar_events set error_count = 0 where ...;
-- puts one back in the queue. A delete or update that answers "not found"
-- (someone deleted the event by hand) is treated as done / recreated.
--
-- Run the flow with Concurrency Control = 1 on the trigger: two overlapping
-- runs would both create the same event.
--
-- Safe to re-run. ASCII only (pasted through the clipboard).


--------------------------------------------------------------------------------
-- 1. The key
--------------------------------------------------------------------------------
alter table public.org_secrets
    add column if not exists leave_calendar_key text;

create unique index if not exists org_secrets_leave_calendar_key_idx
    on public.org_secrets (leave_calendar_key) where leave_calendar_key is not null;

-- rotate_import_key gains the 'leave_calendar' kind. Body carried forward from
-- the live definition (verified on Sydney 2026-10-13) with one extra branch;
-- same signature, so grants survive.
create or replace function public.rotate_import_key(p_kind text, p_org_id bigint default null)
returns text language plpgsql security definer set search_path = public as $function$
declare v_org bigint; v_key text;
begin
    v_org := public.resolve_org_id(p_org_id);
    if not public.is_admin_of(v_org) then raise exception 'not an admin of organisation %', v_org; end if;
    v_key := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    insert into public.org_secrets (organisation_id) values (v_org) on conflict (organisation_id) do nothing;
    if p_kind = 'jobs' then update public.org_secrets set jobs_webhook_key = v_key, updated_at = now() where organisation_id = v_org;
    elsif p_kind = 'tasks' then update public.org_secrets set tasks_webhook_key = v_key, updated_at = now() where organisation_id = v_org;
    elsif p_kind = 'dept_codes' then update public.org_secrets set dept_codes_webhook_key = v_key, updated_at = now() where organisation_id = v_org;
    elsif p_kind = 'invoices' then update public.org_secrets set invoices_webhook_key = v_key, updated_at = now() where organisation_id = v_org;
    elsif p_kind = 'quotes' then update public.org_secrets set quotes_webhook_key = v_key, updated_at = now() where organisation_id = v_org;
    elsif p_kind = 'leave_calendar' then update public.org_secrets set leave_calendar_key = v_key, updated_at = now() where organisation_id = v_org;
    else raise exception 'unknown kind: %, expected jobs, tasks, dept_codes, invoices, quotes, or leave_calendar', p_kind;
    end if;
    return v_key;
end$function$;


--------------------------------------------------------------------------------
-- 2. What we last put on the calendar
--------------------------------------------------------------------------------
create table if not exists public.leave_calendar_events (
    leave_request_id bigint primary key,
    organisation_id  bigint not null references public.organisations(id) on delete cascade,
    event_id         text,            -- null = a create that has not succeeded yet
    subject          text,
    start_date       date,
    end_date         date,
    synced_at        timestamptz,
    error_count      integer not null default 0,
    last_error       text,
    last_error_at    timestamptz
);

create index if not exists leave_calendar_events_org_idx
    on public.leave_calendar_events (organisation_id);

comment on table public.leave_calendar_events is
    '192: the calendar event each approved leave request was last synced to, '
    'written only by leave_calendar_ack. No FK to leave_requests on purpose.';

-- Only the two SECURITY DEFINER functions below touch it.
alter table public.leave_calendar_events enable row level security;
revoke all on public.leave_calendar_events from anon, authenticated;


--------------------------------------------------------------------------------
-- 3. The subject line - the one place to change what the calendar says
--------------------------------------------------------------------------------
create or replace function public.leave_calendar_subject(p_name text, p_hours_per_day numeric)
returns text language sql immutable set search_path = public as $function$
    select coalesce(nullif(trim(p_name), ''), 'Someone') || ' - On leave'
        || case when p_hours_per_day is not null and p_hours_per_day < 8
                then ' (' || trim_scale(p_hours_per_day)::text || 'h/day)'
                else '' end;
$function$;


--------------------------------------------------------------------------------
-- 4. leave_calendar_pending - the operations owed
--------------------------------------------------------------------------------
-- Returns {ok, organisation_id, today, stuck, ops: [...]}; each op:
--   op               'create' | 'update' | 'delete'
--   leave_request_id
--   event_id         null for create
--   subject, start_date, end_date   (end_date inclusive, yyyy-mm-dd)
--   graph_body       a Microsoft Graph event (null for delete): all-day,
--                    New Zealand time, end = the day AFTER end_date as Graph
--                    requires, shown as Free, no reminder.
-- Deletes first, then updates, then creates by start date.
create or replace function public.leave_calendar_pending(p_api_key text, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $function$
declare
    v_org   bigint;
    v_today date := (now() at time zone 'Pacific/Auckland')::date;
    v_ops   jsonb;
    v_stuck integer;
begin
    if p_api_key is null or length(p_api_key) < 16 then raise exception 'invalid api key'; end if;
    select s.organisation_id into v_org from public.org_secrets s where s.leave_calendar_key = p_api_key;
    if v_org is null then raise exception 'unknown api key'; end if;

    with want as (
        select lr.id, public.leave_calendar_subject(u.name, lr.hours_per_day) as subject,
               lr.start_date, lr.end_date
          from public.leave_requests lr
          join public.users u on u.id = lr.user_id
         where lr.organisation_id = v_org
           and lr.status = 'approved'
           and lr.start_date is not null and lr.end_date is not null
           and coalesce(u.is_test, false) = false
    ), have as (
        select * from public.leave_calendar_events e
         where e.organisation_id = v_org and e.error_count < 5
    ), ops as (
        select 1 as ord, 'delete' as op, h.leave_request_id, h.event_id,
               h.subject, h.start_date, h.end_date
          from have h
         where h.event_id is not null
           and not exists (select 1 from want w where w.id = h.leave_request_id)
        union all
        select 2, 'update', w.id, h.event_id, w.subject, w.start_date, w.end_date
          from want w join have h on h.leave_request_id = w.id
         where h.event_id is not null
           and (h.subject, h.start_date, h.end_date) is distinct from (w.subject, w.start_date, w.end_date)
        union all
        select 3, 'create', w.id, null, w.subject, w.start_date, w.end_date
          from want w
         where w.end_date >= v_today
           and not exists (select 1 from public.leave_calendar_events e
                            where e.leave_request_id = w.id
                              and (e.event_id is not null or e.error_count >= 5))
    )
    select coalesce(jsonb_agg(jsonb_build_object(
               'op', o.op,
               'leave_request_id', o.leave_request_id,
               'event_id', o.event_id,
               'subject', o.subject,
               'start_date', to_char(o.start_date, 'YYYY-MM-DD'),
               'end_date', to_char(o.end_date, 'YYYY-MM-DD'),
               'graph_body', case when o.op = 'delete' then null else jsonb_build_object(
                   'subject', o.subject,
                   'body', jsonb_build_object('contentType', 'text', 'content',
                       'Leave ' || to_char(o.start_date, 'Dy FMDD Mon YYYY')
                       || case when o.end_date <> o.start_date
                               then ' to ' || to_char(o.end_date, 'Dy FMDD Mon YYYY') else '' end
                       || '. Added automatically from the PTL Timesheet - change the leave there, not here.'),
                   'start', jsonb_build_object('dateTime', to_char(o.start_date, 'YYYY-MM-DD') || 'T00:00:00',
                                               'timeZone', 'New Zealand Standard Time'),
                   'end',   jsonb_build_object('dateTime', to_char(o.end_date + 1, 'YYYY-MM-DD') || 'T00:00:00',
                                               'timeZone', 'New Zealand Standard Time'),
                   'isAllDay', true,
                   'showAs', 'free',
                   'isReminderOn', false) end
           ) order by o.ord, o.start_date, o.leave_request_id), '[]'::jsonb)
      into v_ops
      from (select * from ops order by ord, start_date, leave_request_id
             limit greatest(1, least(coalesce(p_limit, 100), 500))) o;

    select count(*) into v_stuck from public.leave_calendar_events
     where organisation_id = v_org and error_count >= 5;

    return jsonb_build_object('ok', true, 'organisation_id', v_org, 'today', v_today,
                              'stuck', v_stuck, 'ops', v_ops);
end$function$;


--------------------------------------------------------------------------------
-- 5. leave_calendar_ack - record what the flow did
--------------------------------------------------------------------------------
-- p_results: one op object or an array of them - the op exactly as pending
-- returned it, plus
--   ok        true / false
--   event_id  the new event's id (create)
--   error     the failure text (when ok is false)
-- In Power Automate: setProperty(setProperty(item(), 'ok', true), 'event_id', <id>).
-- A delete/update failing with not-found (404 / ErrorItemNotFound) means the
-- event was removed by hand: a delete counts as done, an update re-creates.
create or replace function public.leave_calendar_ack(p_api_key text, p_results jsonb)
returns jsonb language plpgsql security definer set search_path = public as $function$
declare
    v_org   bigint;
    r       jsonb;
    v_id    bigint;
    v_op    text;
    v_ok    boolean;
    v_err   text;
    v_gone  boolean;
    v_done  integer := 0;
    v_fail  integer := 0;
begin
    if p_api_key is null or length(p_api_key) < 16 then raise exception 'invalid api key'; end if;
    select s.organisation_id into v_org from public.org_secrets s where s.leave_calendar_key = p_api_key;
    if v_org is null then raise exception 'unknown api key'; end if;

    for r in select x from jsonb_array_elements(
                 case jsonb_typeof(p_results) when 'array' then p_results
                                              when 'object' then jsonb_build_array(p_results)
                                              else '[]'::jsonb end) as t(x)
    loop
        v_id  := nullif(r->>'leave_request_id', '')::bigint;
        v_op  := r->>'op';
        v_ok  := coalesce((r->>'ok')::boolean, false);
        v_err := left(coalesce(r->>'error', case when v_ok then null else 'failed (no error text sent)' end), 2000);
        v_gone := not v_ok and (v_err ~* '(404|not ?found|ErrorItemNotFound)');
        continue when v_id is null or v_op not in ('create', 'update', 'delete');

        -- A request id from another organisation is ignored, never written.
        if v_op <> 'delete' and not exists (select 1 from public.leave_requests
                                            where id = v_id and organisation_id = v_org) then
            continue;
        end if;
        if v_op = 'delete' and not exists (select 1 from public.leave_calendar_events
                                           where leave_request_id = v_id and organisation_id = v_org) then
            continue;
        end if;

        if v_ok and v_op = 'create' and nullif(r->>'event_id', '') is null then
            v_ok := false; v_err := 'create reported ok without an event_id'; v_gone := false;
        end if;

        if v_op = 'delete' and (v_ok or v_gone) then
            delete from public.leave_calendar_events where leave_request_id = v_id and organisation_id = v_org;
            v_done := v_done + 1;
        elsif v_ok then
            insert into public.leave_calendar_events
                   (leave_request_id, organisation_id, event_id, subject, start_date, end_date,
                    synced_at, error_count, last_error, last_error_at)
            values (v_id, v_org,
                    coalesce(nullif(r->>'event_id', ''),
                             (select event_id from public.leave_calendar_events where leave_request_id = v_id)),
                    r->>'subject', (r->>'start_date')::date, (r->>'end_date')::date,
                    now(), 0, null, null)
            on conflict (leave_request_id) do update
               set event_id = excluded.event_id, subject = excluded.subject,
                   start_date = excluded.start_date, end_date = excluded.end_date,
                   synced_at = now(), error_count = 0, last_error = null, last_error_at = null;
            v_done := v_done + 1;
        elsif v_op = 'update' and v_gone then
            -- Event deleted by hand: forget it, the next run re-creates it.
            update public.leave_calendar_events
               set event_id = null, error_count = 0, last_error = v_err, last_error_at = now()
             where leave_request_id = v_id and organisation_id = v_org;
            v_done := v_done + 1;
        else
            insert into public.leave_calendar_events
                   (leave_request_id, organisation_id, error_count, last_error, last_error_at)
            values (v_id, v_org, 1, v_err, now())
            on conflict (leave_request_id) do update
               set error_count = public.leave_calendar_events.error_count + 1,
                   last_error = excluded.last_error, last_error_at = now();
            v_fail := v_fail + 1;
        end if;
    end loop;

    return jsonb_build_object('ok', true, 'recorded', v_done, 'failed', v_fail);
end$function$;


--------------------------------------------------------------------------------
-- 6. Grants - the flow calls as anon; the key is the gate
--------------------------------------------------------------------------------
revoke all on function public.leave_calendar_pending(text, integer) from public;
revoke all on function public.leave_calendar_ack(text, jsonb)      from public;
grant execute on function public.leave_calendar_pending(text, integer) to anon, authenticated, service_role;
grant execute on function public.leave_calendar_ack(text, jsonb)      to anon, authenticated, service_role;
