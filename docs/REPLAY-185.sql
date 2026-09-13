-- REPLAY-185.sql — reproduces the damage 174 did, then proves 185 stops it.
--
-- Run from supabase/migrations (the \i paths are relative):
--
--   export PGPASSWORD=postgres
--   cd supabase/migrations
--   /c/erp/pg17/pgsql/bin/psql.exe -h localhost -p 5433 -U postgres \
--       -d timesheet -f ../../docs/REPLAY-185.sql
--
-- Start the snapshot cluster first with C:\erp\pg17\start-timesheet-db.cmd.
-- Everything rolls back; the real webhook keys are never read.
\set ON_ERROR_STOP on
begin;

\i 169_jobs_customer_dates_type.sql
\i 170_parse_excel_serial_dates.sql
\i 173_invoices_webhook.sql
\i 174_invoice_quote_total.sql

update public.org_secrets
   set invoices_webhook_key = 'test-inv-key-1234567890abcdef'
 where organisation_id = 1;

-- A job as the JOBS feed leaves it: typed SPARES, dated, completed.
insert into public.jobs (organisation_id, job_code, description, status, source,
                         job_type, start_date, due_date)
values (1, 'T-185', 'a live spares job', 'COMPLETED', 'webhook',
        'SPARES', date '2026-05-18', date '2026-08-20')
on conflict (organisation_id, job_code) do update
   set job_type = 'SPARES', status = 'COMPLETED',
       start_date = date '2026-05-18', due_date = date '2026-08-20';

-- The quotes export's shape: jobid and invnum, but no title / jobstatus /
-- startdate / duedate / jobtype. This is what was hitting the invoices RPC.
create temp table quote_shaped_payload as
select '[{"invnum":"4083","jobid":"T-185","name":"Kellanova","desc":"a quote line"}]'::jsonb as rows;

-- ========================================================================
-- CASE 1 -- 174, the live body. Reproduce the damage.
-- ========================================================================
select public.ingest_invoices_via_webhook('test-inv-key-1234567890abcdef',
         (select rows from quote_shaped_payload)) as case_1_response;

select 'BEFORE 185 (this is the bug)' as step, job_code, job_type, status, start_date, due_date
  from public.jobs where organisation_id = 1 and job_code = 'T-185';

select '174: job_type is WIPED'            as observation, job_type   is null      as confirmed from public.jobs where job_code='T-185'
union all
select '174: status forced to ACTIVE',                     status = 'ACTIVE'                   from public.jobs where job_code='T-185'
union all
select '174: start_date cleared',                          start_date is null                  from public.jobs where job_code='T-185'
union all
select '174: due_date cleared',                            due_date   is null                  from public.jobs where job_code='T-185';

-- Put the job back as the jobs feed would.
update public.jobs
   set job_type = 'SPARES', status = 'COMPLETED',
       start_date = date '2026-05-18', due_date = date '2026-08-20'
 where organisation_id = 1 and job_code = 'T-185';

-- ========================================================================
-- CASE 2 -- 185. Same payload, nothing should move.
-- ========================================================================
\i 185_invoices_feed_stops_writing_job_type_and_status.sql

select public.ingest_invoices_via_webhook('test-inv-key-1234567890abcdef',
         (select rows from quote_shaped_payload)) as case_2_response;

select 'AFTER 185' as step, job_code, job_type, status, start_date, due_date
  from public.jobs where organisation_id = 1 and job_code = 'T-185';

select 'A: job_type SURVIVES'      as assertion, job_type = 'SPARES'            as pass from public.jobs where job_code='T-185'
union all
select 'B: status SURVIVES',                     status   = 'COMPLETED'                from public.jobs where job_code='T-185'
union all
select 'C: start_date SURVIVES',                 start_date = date '2026-05-18'        from public.jobs where job_code='T-185'
union all
select 'D: due_date SURVIVES',                   due_date   = date '2026-08-20'        from public.jobs where job_code='T-185'
union all
select 'E: the invoice still ingests',
       exists (select 1 from public.invoices where invoice_no = '4083')
union all
select 'F: response reports the absent date columns',
       (public.ingest_invoices_via_webhook('test-inv-key-1234567890abcdef',
          (select rows from quote_shaped_payload))
        -> 'columns_in_payload' ->> 'start_date') = 'false';

-- ========================================================================
-- CASE 3 -- a REAL invoices payload still writes the dates it carries, and
--           still refuses to touch job_type or status.
-- ========================================================================
select public.ingest_invoices_via_webhook('test-inv-key-1234567890abcdef', '[{
  "invnum":"9291","jobid":"T-185","title":"a real invoice",
  "startdate":"6/1/2026","duedate":"9/30/2026",
  "jobtype":"*STD*","jobstatus":"*ACTIVE*",
  "invdate":"9/1/2026","invstatus":"POSTED","quotetotal":"1234.56"}]'::jsonb) as case_3_response;

select 'AFTER a real invoice' as step, job_code, job_type, status, start_date, due_date
  from public.jobs where organisation_id = 1 and job_code = 'T-185';

select 'G: dates the payload DID carry are written' as assertion,
       start_date = date '2026-06-01' and due_date = date '2026-09-30' as pass
  from public.jobs where job_code='T-185'
union all
select 'H: jobtype in the payload is still IGNORED (184 owns it)',
       job_type = 'SPARES' from public.jobs where job_code='T-185'
union all
select 'I: jobstatus in the payload is still IGNORED',
       status = 'COMPLETED' from public.jobs where job_code='T-185'
union all
select 'J: quote_total still lands on the invoice',
       (select quote_total from public.invoices where invoice_no='9291') = 1234.56;

rollback;
