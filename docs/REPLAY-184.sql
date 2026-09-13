-- REPLAY-184.sql — replays 184 (and its prerequisites 169/170/180) against a
-- scratch copy of the snapshot DB and asserts the four behaviours it claims.
--
-- Run from supabase/migrations, because of the \i includes below:
--
--   export PGPASSWORD=postgres
--   cd supabase/migrations
--   /c/erp/pg17/pgsql/bin/psql.exe -h localhost -p 5433 -U postgres \
--       -d timesheet -f ../../docs/REPLAY-184.sql
--
-- Start the snapshot cluster first with C:\erp\pg17\start-timesheet-db.cmd.
--
-- Everything runs inside a transaction that ROLLS BACK, so the snapshot is left
-- exactly as it was and the real webhook key is never read or printed — the
-- test swaps in one of its own.
--
-- Written because a build-script assertion only confirms what I meant; this
-- confirms what Postgres actually does.

\set ON_ERROR_STOP on
begin;

\i 169_jobs_customer_dates_type.sql
\i 170_parse_excel_serial_dates.sql
\i 180_jobs_webhook_lean_payload.sql
\i 184_jobs_webhook_type_and_status_presence.sql

-- Test key, inside the rolled-back transaction, so the snapshot's real key is
-- never read or printed.
update public.org_secrets set jobs_webhook_key = 'test-key-1234567890abcdef' where organisation_id = 1;

-- The LIVE map exactly as production has it: status_column = "status", and no
-- type_column at all.
update public.organisations set jobs_import_map = '{
  "status_map":{"DEP":"DEP","*COMP*":"COMPLETED","PARTIAL":"PARTIAL","*ACTIVE*":"ACTIVE","INVOICED":"INVOICED","DISPATCHED":"DISPATCHED"},
  "code_column":"jobid","status_column":"status","description_column":"title"}'::jsonb
where id = 1;

-- Three real job codes out of the snapshot, so the UPDATE arm is what fires.
create temp table probe as
  select job_code, status as status_before, description as desc_before
  from public.jobs where organisation_id = 1 and status <> 'ACTIVE' order by job_code limit 3;
select 'PROBE (must be non-ACTIVE to prove the flatten)' as step, * from probe;

-- =========================================================================
-- CASE 1 -- the payload as the sender now emits it, against the UNFIXED map.
-- =========================================================================
create temp table r1 as
select public.ingest_jobs_via_webhook('test-key-1234567890abcdef',
  (select jsonb_agg(jsonb_build_object(
      'jobid', job_code, 'title', desc_before,
      'jobtype', case when job_code like '%8' then 'SPARES' else '*STD*' end,
      'jobstatus', '*COMP*')) from probe)) as res;
select 'CASE 1 result' as step, res from r1;

select 'CASE 1: status must be UNCHANGED (not flattened to ACTIVE)' as assertion,
       bool_and(j.status = p.status_before) as pass
from probe p join public.jobs j on j.organisation_id = 1 and j.job_code = p.job_code;

select 'CASE 1: job_type must be SET from jobtype' as assertion,
       bool_and(j.job_type is not null) as pass,
       string_agg(distinct j.job_type, ',') as types
from probe p join public.jobs j on j.organisation_id = 1 and j.job_code = p.job_code;

select 'CASE 1: columns_in_payload.status must be false' as assertion,
       (res->'columns_in_payload'->>'status') = 'false' as pass from r1;
select 'CASE 1: columns_in_payload.job_type must be true' as assertion,
       (res->'columns_in_payload'->>'job_type') = 'true' as pass from r1;

-- =========================================================================
-- CASE 2 -- same payload, map repaired.
-- =========================================================================
update public.organisations
   set jobs_import_map = jsonb_set(jobs_import_map, '{status_column}', '"jobstatus"')
 where id = 1;

create temp table r2 as
select public.ingest_jobs_via_webhook('test-key-1234567890abcdef',
  (select jsonb_agg(jsonb_build_object(
      'jobid', job_code, 'title', desc_before,
      'jobtype', case when job_code like '%8' then 'SPARES' else '*STD*' end,
      'jobstatus', '*COMP*')) from probe)) as res;
select 'CASE 2 result' as step, res from r2;

select 'CASE 2: *COMP* must map to COMPLETED' as assertion,
       bool_and(j.status = 'COMPLETED') as pass
from probe p join public.jobs j on j.organisation_id = 1 and j.job_code = p.job_code;

select 'CASE 2: columns_in_payload.status must be true' as assertion,
       (res->'columns_in_payload'->>'status') = 'true' as pass from r2;

-- =========================================================================
-- CASE 3 -- a payload with NO jobtype must not wipe the stored job_type.
--           (This is 180's FAULT 1 in reverse -- the thing that made 180
--           take job_type off this feed in the first place.)
-- =========================================================================
create temp table r3 as
select public.ingest_jobs_via_webhook('test-key-1234567890abcdef',
  (select jsonb_agg(jsonb_build_object(
      'jobid', job_code, 'title', desc_before, 'jobstatus', '*ACTIVE*')) from probe)) as res;
select 'CASE 3 result' as step, res from r3;

select 'CASE 3: job_type must SURVIVE a payload without the key' as assertion,
       bool_and(j.job_type is not null) as pass
from probe p join public.jobs j on j.organisation_id = 1 and j.job_code = p.job_code;

select 'CASE 3: status IS present so it must move to ACTIVE' as assertion,
       bool_and(j.status = 'ACTIVE') as pass
from probe p join public.jobs j on j.organisation_id = 1 and j.job_code = p.job_code;

-- =========================================================================
-- CASE 4 -- 180's job-code guard must still raise.
-- =========================================================================
select 'CASE 4: a payload with no job code must RAISE' as assertion;
do $$
begin
  perform public.ingest_jobs_via_webhook('test-key-1234567890abcdef',
    '[{"wrongkey":"x","jobstatus":"*COMP*"}]'::jsonb);
  raise exception 'FAIL -- no exception raised';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  raise notice 'PASS -- raised: %', left(sqlerrm, 120);
end$$;

rollback;
