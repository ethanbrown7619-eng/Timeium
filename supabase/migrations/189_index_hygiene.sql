-- ============================================================================
-- 189_index_hygiene.sql (Timeium)
-- SQL efficiency audit 2026-09-24, lanes L5 (+ the four public.jobs drops L4
-- and L5 each left for the other), reviewed 2026-09-24. Independent of
-- 187/188; apply any time.
--
-- Evidence: production pg_stat_user_indexes (postmaster start 2026-09-17
-- 20:07 UTC, so ~7 days of real traffic - a lower bound, not proof of
-- death), pg_get_indexdef for exact-duplicate detection, pg_constraint for
-- anything an index backs, and a grep of C:\erp\Time\Timeium and every
-- C:\erp\parts repo for each index NAME (only the migrations that created
-- them and the schema-replica.sql dump mention any of them).
--
-- DROPS
--   public.timesheet_entries.ix_timesheet_entries_ts  (timesheet_id)  0 scans
--     Byte-identical to timesheet_entries_ts_idx (1,931 scans). Exact dup.
--   public.users.users_auth_user_id_key   UNIQUE (auth_user_id) WHERE NOT NULL  0 scans
--     Byte-identical to users_auth_user_id_uniq (577,478 scans - the RLS hot
--     path current_org_id -> map.user_org_ids -> users by auth.uid(), and
--     the shape 119/187/0041's inlined subqueries use). Neither backs a
--     pg_constraint row; no FK targets users(auth_user_id). _uniq is
--     migration 163's documented invariant (docs/SECURITY.md 10.5), _key is
--     022's undocumented predecessor. Tokyo shows the planner splitting the
--     same lookups between the two; after the drop they consolidate.
--   public.users.ix_users_auth_user_id    (auth_user_id) non-unique, 0 scans
--     Subsumed by users_auth_user_id_uniq for every equality lookup (the
--     only pattern: every row has auth_user_id set on production).
--   public.jobs.jobs_org_idx              (organisation_id)          0 scans
--     Prefix of the unique jobs_organisation_id_job_code_key (43M scans).
--   public.jobs.jobs_org_status_idx       (organisation_id, status)  0 scans
--     No RPC or page filters jobs by status through it (Tokyo: 21 scans in
--     two months; those queries are served by the unique key's prefix).
--   public.jobs.jobs_leave_type_idx       (leave_type_id)            0 scans
--     jobs.leave_type_id is the STALE mapping (the live one is
--     leave_types.job_id). It does back jobs_leave_type_id_fkey ON DELETE
--     SET NULL: deleting a leave_types row will seq-scan jobs (6,759 rows,
--     ~1 ms) - a rare admin action, accepted.
--   public.jobs.jobs_description_idx      gin(to_tsvector(description)) 0 scans, 1.2 MB
--     Created by 030 for a full-text search that was never built (no
--     to_tsvector / textSearch / plainto_tsquery on jobs anywhere in the
--     repo). Maintained on every one of the 6,955 job updates per push.
--
-- ADD
--   public.timesheet_entries.timesheet_entries_job_id_idx (job_id)
--     FK timesheet_entries_job_id_fkey -> jobs(id) ON DELETE SET NULL had no
--     covering index (992 kB table). Timesheet reads by job_id directly
--     (migrations 032, 123/148, 136/137/138/152). Tokyo: the RI check goes
--     from a seq scan / 128 buffers to an index scan / 4 buffers; a direct
--     filter on the most common job is a wash today. 64 kB.
--
-- KEPT, with reasons, in L5-findings.md: every UNIQUE business-rule index on
-- users (qr_token, rfid_uid, org+email, org+employee_code), the payroll /
-- org-chart FK indexes, users_org_idx (covers rows the partial unique index
-- cannot), ix_departments_org_active, invoices_org_date_idx /
-- invoices_org_job_idx (reporting paths, not duplicates).
--
-- APPLY NOTE. DROP INDEX takes AccessExclusive on public.users and
-- public.jobs - the two hottest tables in the database - for the rest of
-- this short transaction; lock_timeout 10 s so a queued reader fails this
-- file rather than the app. Re-run if it times out. CREATE INDEX is
-- non-concurrent (the SQL editor runs one transaction; 5,886 rows).
-- Idempotent. ASCII-only.
-- ============================================================================

begin;
set local lock_timeout = '10s';
set local statement_timeout = '2min';

drop index if exists public.ix_timesheet_entries_ts;

create index if not exists timesheet_entries_job_id_idx
  on public.timesheet_entries using btree (job_id);

drop index if exists public.users_auth_user_id_key;
drop index if exists public.ix_users_auth_user_id;

drop index if exists public.jobs_org_idx;
drop index if exists public.jobs_org_status_idx;
drop index if exists public.jobs_leave_type_idx;
drop index if exists public.jobs_description_idx;

-- ------------------------------------------------------------- the check --
do $chk$
begin
  if not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'users' and indexname = 'users_auth_user_id_uniq') then
    raise exception '189 NOT applied - users_auth_user_id_uniq (the index that must survive) is missing. Everything rolled back.';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'jobs' and indexname = 'jobs_organisation_id_job_code_key') then
    raise exception '189 NOT applied - jobs_organisation_id_job_code_key is missing. Everything rolled back.';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'timesheet_entries' and indexname = 'timesheet_entries_ts_idx') then
    raise exception '189 NOT applied - timesheet_entries_ts_idx (the index that must survive) is missing. Everything rolled back.';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'timesheet_entries' and indexname = 'timesheet_entries_job_id_idx') then
    raise exception '189 NOT applied - timesheet_entries_job_id_idx was not created. Everything rolled back.';
  end if;
  raise notice '189 applied: users % indexes, jobs % indexes, timesheet_entries % indexes',
    (select count(*) from pg_indexes where schemaname = 'public' and tablename = 'users'),
    (select count(*) from pg_indexes where schemaname = 'public' and tablename = 'jobs'),
    (select count(*) from pg_indexes where schemaname = 'public' and tablename = 'timesheet_entries');
end $chk$;

commit;

-- The SQL editor shows only the last result: expect jobs = jobs_organisation_id_job_code_key,jobs_pkey
-- and users without users_auth_user_id_key / ix_users_auth_user_id.
select tablename, string_agg(indexname, ',' order by indexname) as indexes
  from pg_indexes
 where schemaname = 'public' and tablename in ('jobs', 'users', 'timesheet_entries')
 group by tablename
 order by tablename;
