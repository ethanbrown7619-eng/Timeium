-- 194_leave_calendar_weekdays.sql - leave on the company calendar skips
-- Saturday and Sunday.
--
-- User, 2026-10-14: "we need to make it not populate on Saturday and Sunday on
-- the leave calendar". 192 put ONE all-day event per approved request, start to
-- end, so a Mon 12 - Mon 19 request painted the weekend between.
--
-- Now a request is split into its WEEKDAY RUNS - each unbroken Mon-Fri stretch
-- is one event:
--   Mon 12 - Mon 19 Oct  ->  Mon 12 - Fri 16  +  Mon 19
--   Fri 16 - Mon 19      ->  Fri 16           +  Mon 19
--   Sat 17 - Sun 18      ->  nothing (and an existing event is deleted)
-- Public holidays are NOT skipped - only Saturday and Sunday.
--
-- The calendar unit is now (leave_request_id, seg_no): seg_no is the run's
-- position in the request, 1, 2, 3... Keying on the position, not the date,
-- means moving leave by a few days PATCHes the same events rather than
-- deleting and re-creating them. A request that loses a run has the extra
-- event deleted; one that gains a run gets it created.
--
-- THE FLOW NEEDS NO CHANGE. Each op gains a `seg_no`, and the flow already
-- hands the op back to leave_calendar_ack untouched (setProperty on item()).
-- An ack without seg_no (an op fetched before 194) is read as seg_no 1.
--
-- Existing rows become seg_no 1. The next run PATCHes each one down to its
-- first weekday run and creates the rest - the test calendar fixes itself.
--
-- Both functions are 192's (live Sydney checked identical, 2026-10-14) with
-- the seg_no changes; signatures and grants unchanged. Safe to re-run.
-- One transaction. ASCII-only.

begin;

--------------------------------------------------------------------------------
-- 1. The calendar row is one weekday run of a request
--------------------------------------------------------------------------------
alter table public.leave_calendar_events
    add column if not exists seg_no integer not null default 1;

do $$
begin
    if exists (select 1 from pg_constraint
                where conname = 'leave_calendar_events_pkey'
                  and conrelid = 'public.leave_calendar_events'::regclass
                  and pg_get_constraintdef(oid) not ilike '%seg_no%') then
        alter table public.leave_calendar_events drop constraint leave_calendar_events_pkey;
        alter table public.leave_calendar_events
            add constraint leave_calendar_events_pkey primary key (leave_request_id, seg_no);
    end if;
end $$;

comment on column public.leave_calendar_events.seg_no is
    '194: which weekday run of the request this event is (1, 2, ...); weekends are left off the calendar.';


--------------------------------------------------------------------------------
-- 2. A date range's weekday runs
--------------------------------------------------------------------------------
-- Consecutive weekdays share (day - its position among the weekdays), so that
-- difference groups each Mon-Fri stretch. Empty for an all-weekend range or
-- an end before the start.
create or replace function public.leave_calendar_segments(p_start date, p_end date)
returns table (seg_no integer, seg_start date, seg_end date)
language sql immutable set search_path = public as $function$
    select (row_number() over (order by min(x.d)))::integer, min(x.d), max(x.d)
      from (select g.d::date as d,
                   g.d::date - (row_number() over (order by g.d))::integer as grp
              from generate_series(p_start, p_end, interval '1 day') as g(d)
             where extract(isodow from g.d) < 6) x
     group by x.grp
     order by 2;
$function$;


--------------------------------------------------------------------------------
-- 3. leave_calendar_pending - the operations owed (192 + seg_no)
--------------------------------------------------------------------------------
-- Each op as in 192, plus seg_no; start_date / end_date are now the RUN's
-- dates. The event body still names the whole request's dates.
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

    with req as (
        select lr.id, public.leave_calendar_subject(u.name, lr.hours_per_day) as subject,
               lr.start_date, lr.end_date
          from public.leave_requests lr
          join public.users u on u.id = lr.user_id
         where lr.organisation_id = v_org
           and lr.status = 'approved'
           and lr.start_date is not null and lr.end_date is not null
           and coalesce(u.is_test, false) = false
    ), want as (
        -- 194: one row per weekday run of each request.
        select r.id, s.seg_no, r.subject, s.seg_start as start_date, s.seg_end as end_date,
               r.start_date as req_start, r.end_date as req_end
          from req r
          cross join lateral public.leave_calendar_segments(r.start_date, r.end_date) s
    ), have as (
        select * from public.leave_calendar_events e
         where e.organisation_id = v_org and e.error_count < 5
    ), ops as (
        select 1 as ord, 'delete' as op, h.leave_request_id, h.seg_no, h.event_id,
               h.subject, h.start_date, h.end_date, null::date as req_start, null::date as req_end
          from have h
         where h.event_id is not null
           and not exists (select 1 from want w where w.id = h.leave_request_id and w.seg_no = h.seg_no)
        union all
        select 2, 'update', w.id, w.seg_no, h.event_id, w.subject, w.start_date, w.end_date,
               w.req_start, w.req_end
          from want w join have h on h.leave_request_id = w.id and h.seg_no = w.seg_no
         where h.event_id is not null
           and (h.subject, h.start_date, h.end_date) is distinct from (w.subject, w.start_date, w.end_date)
        union all
        select 3, 'create', w.id, w.seg_no, null, w.subject, w.start_date, w.end_date,
               w.req_start, w.req_end
          from want w
         where w.end_date >= v_today
           and not exists (select 1 from public.leave_calendar_events e
                            where e.leave_request_id = w.id and e.seg_no = w.seg_no
                              and (e.event_id is not null or e.error_count >= 5))
    )
    select coalesce(jsonb_agg(jsonb_build_object(
               'op', o.op,
               'leave_request_id', o.leave_request_id,
               'seg_no', o.seg_no,
               'event_id', o.event_id,
               'subject', o.subject,
               'start_date', to_char(o.start_date, 'YYYY-MM-DD'),
               'end_date', to_char(o.end_date, 'YYYY-MM-DD'),
               'graph_body', case when o.op = 'delete' then null else jsonb_build_object(
                   'subject', o.subject,
                   'body', jsonb_build_object('contentType', 'text', 'content',
                       'Leave ' || to_char(o.req_start, 'Dy FMDD Mon YYYY')
                       || case when o.req_end <> o.req_start
                               then ' to ' || to_char(o.req_end, 'Dy FMDD Mon YYYY') else '' end
                       || '. Added automatically from the PTL Timesheet - change the leave there, not here.'),
                   'start', jsonb_build_object('dateTime', to_char(o.start_date, 'YYYY-MM-DD') || 'T00:00:00',
                                               'timeZone', 'New Zealand Standard Time'),
                   'end',   jsonb_build_object('dateTime', to_char(o.end_date + 1, 'YYYY-MM-DD') || 'T00:00:00',
                                               'timeZone', 'New Zealand Standard Time'),
                   'isAllDay', true,
                   'showAs', 'free',
                   'isReminderOn', false) end
           ) order by o.ord, o.start_date, o.leave_request_id, o.seg_no), '[]'::jsonb)
      into v_ops
      from (select * from ops order by ord, start_date, leave_request_id, seg_no
             limit greatest(1, least(coalesce(p_limit, 100), 500))) o;

    select count(*) into v_stuck from public.leave_calendar_events
     where organisation_id = v_org and error_count >= 5;

    return jsonb_build_object('ok', true, 'organisation_id', v_org, 'today', v_today,
                              'stuck', v_stuck, 'ops', v_ops);
end$function$;


--------------------------------------------------------------------------------
-- 4. leave_calendar_ack - record what the flow did (192 + seg_no)
--------------------------------------------------------------------------------
create or replace function public.leave_calendar_ack(p_api_key text, p_results jsonb)
returns jsonb language plpgsql security definer set search_path = public as $function$
declare
    v_org   bigint;
    r       jsonb;
    v_id    bigint;
    v_seg   integer;
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
        -- 194: an op fetched before 194 carries no seg_no - it was the whole request, seg 1.
        v_seg := coalesce(nullif(r->>'seg_no', '')::integer, 1);
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
                                           where leave_request_id = v_id and seg_no = v_seg
                                             and organisation_id = v_org) then
            continue;
        end if;

        if v_ok and v_op = 'create' and nullif(r->>'event_id', '') is null then
            v_ok := false; v_err := 'create reported ok without an event_id'; v_gone := false;
        end if;

        if v_op = 'delete' and (v_ok or v_gone) then
            delete from public.leave_calendar_events
             where leave_request_id = v_id and seg_no = v_seg and organisation_id = v_org;
            v_done := v_done + 1;
        elsif v_ok then
            insert into public.leave_calendar_events
                   (leave_request_id, seg_no, organisation_id, event_id, subject, start_date, end_date,
                    synced_at, error_count, last_error, last_error_at)
            values (v_id, v_seg, v_org,
                    coalesce(nullif(r->>'event_id', ''),
                             (select event_id from public.leave_calendar_events
                               where leave_request_id = v_id and seg_no = v_seg)),
                    r->>'subject', (r->>'start_date')::date, (r->>'end_date')::date,
                    now(), 0, null, null)
            on conflict (leave_request_id, seg_no) do update
               set event_id = excluded.event_id, subject = excluded.subject,
                   start_date = excluded.start_date, end_date = excluded.end_date,
                   synced_at = now(), error_count = 0, last_error = null, last_error_at = null;
            v_done := v_done + 1;
        elsif v_op = 'update' and v_gone then
            -- Event deleted by hand: forget it, the next run re-creates it.
            update public.leave_calendar_events
               set event_id = null, error_count = 0, last_error = v_err, last_error_at = now()
             where leave_request_id = v_id and seg_no = v_seg and organisation_id = v_org;
            v_done := v_done + 1;
        else
            insert into public.leave_calendar_events
                   (leave_request_id, seg_no, organisation_id, error_count, last_error, last_error_at)
            values (v_id, v_seg, v_org, 1, v_err, now())
            on conflict (leave_request_id, seg_no) do update
               set error_count = public.leave_calendar_events.error_count + 1,
                   last_error = excluded.last_error, last_error_at = now();
            v_fail := v_fail + 1;
        end if;
    end loop;

    return jsonb_build_object('ok', true, 'recorded', v_done, 'failed', v_fail);
end$function$;

-- The helper is pure date arithmetic; only the two definers above call it.
revoke all on function public.leave_calendar_segments(date, date) from public;

commit;

-- Expect: one row, all true.
select pg_get_constraintdef((select oid from pg_constraint
         where conname = 'leave_calendar_events_pkey'
           and conrelid = 'public.leave_calendar_events'::regclass)) ilike '%seg_no%'    as pk_has_seg,
       (select count(*) from public.leave_calendar_segments(date '2026-10-12', date '2026-10-19')) = 2
                                                                                        as mon_to_mon_is_2_runs,
       (select count(*) from public.leave_calendar_segments(date '2026-10-17', date '2026-10-18')) = 0
                                                                                        as weekend_only_is_none,
       (select prosrc ilike '%seg_no%' from pg_proc
         where oid = 'public.leave_calendar_ack(text,jsonb)'::regprocedure)              as ack_has_seg;
