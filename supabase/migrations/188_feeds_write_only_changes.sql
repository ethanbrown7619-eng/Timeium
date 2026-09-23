-- ============================================================================
-- 188_feeds_write_only_changes.sql (Timeium)
-- SQL efficiency audit 2026-09-24, lane L4, reviewed 2026-09-24.
-- Independent of 187/189; apply any time. Bodies below were lifted from
-- PRODUCTION on 2026-09-24 (md5 re-checked by the reviewer: unchanged since
-- the survey; equal to Timeium 184 / 181 / 186 verbatim before editing).
--
-- REVIEWER'S SUMMARY (the full account is in the original header below):
--   * ingest_jobs_via_webhook and the jobs arm of ingest_invoices_via_webhook
--     only write a public.jobs row when a value it controls actually changes
--     (or source is not 'webhook'). Production wrote 6,955 job rows per push
--     (every row, every 15 min; 547 autovacuums in 6 days) - Tokyo: 0 on an
--     identical re-push, exactly 3 when 3 jobs changed.
--   * ingest_quotes_via_webhook diffs quote_lines instead of wiping and
--     re-inserting them (1,080 ins + 1,080 del per push -> 0 / 1 / 1 in the
--     three Tokyo scenarios). The quote HEADER upsert is deliberately
--     unchanged: quotes.last_seen_at is a presence heartbeat po.live_tasks
--     reads. The invoice ledger arm is deliberately unchanged: sync_token
--     must move on every row or the p_final prune would delete live rows.
--   * OWNER DECISION: the admin Configure page's "Last synced" shows
--     jobs.last_synced_at, which will now mean "last time this job's
--     content changed", not "last time the feed ran". Nothing else reads
--     jobs.last_synced_at / updated_at as a freshness signal (grepped).
--   * FINDING, not fixed here: production's ingest_quotes_via_webhook equals
--     181, which was built on 178, not 179 - 179's 24-month quote age window
--     is NOT live. A separate migration should decide whether to restore it.
--
-- GUARD. No live data can be fingerprinted at apply time (calling a feed
-- function needs a real key and performs a real push); the data-identity
-- proof is the Tokyo run in L4-findings.md (md5 of every row, three
-- scenarios, OLD == NEW). The DO block at the end asserts the objects this
-- file relies on (the quote_lines unique constraint the new ON CONFLICT
-- targets, trg_jobs_updated_at) and that the guard/diff text landed, and
-- rolls back otherwise. Grants restated exactly as production has them.
-- Idempotent. ASCII-only.
-- ============================================================================

begin;
set local statement_timeout = '3min';
set local lock_timeout = '10s';

-- ---- original L4 header and bodies (production-lifted, see L4-findings.md) ----
-- 188_feeds_write_only_changes.sql -- lane L4 original header follows.
--
-- SQL efficiency audit, lane L4 (public.jobs / quotes / quote_lines / invoices
-- churn from the three Infusion feed webhooks). Bodies lifted from PRODUCTION
-- (Sydney) via pg_get_functiondef and confirmed byte-identical to Timeium
-- migrations 184 (jobs), 181 (quotes) and 186 (invoices) before editing. Tested
-- against TOKYO inside a rolled-back transaction with savepoints (never
-- committed) -- see sql-audit/L4-findings.md for the full method and numbers.
-- This file only touches ASCII.
--
--
-- THE PROBLEM (production, pg_stat_user_tables, 2026-09-17 20:06 -> 09-23 18:10,
-- 5.9 days, ~93 pushes/day):
--
--   public.jobs         n_tup_upd 3,846,272 (6,955/push) for 6,759 live rows,
--                        547 autovacuums. Every job rewritten by the JOBS feed
--                        AND (separately) up to ~70/push more by the INVOICES
--                        feed's own job-arm.
--   public.quotes        n_tup_upd   181,353  (327/push = all 327 quotes)
--   public.quote_lines   598,565 ins / 597,394 del (~1,080/push) for a table
--                        that only ever holds ~1,100 rows -- wiped and
--                        reinserted whole on every push regardless of change.
--   public.invoices      n_tup_upd    40,103   (72/push = all)
--
-- Root cause: every ON CONFLICT DO UPDATE in all three functions fires
-- unconditionally (no WHERE clause), so a conflicting row is rewritten even
-- when every value it would receive is identical to what is already stored;
-- quote_lines has no per-line identity at all, so the function deletes every
-- line of every touched quote and reinserts the lot, every time.
--
--
-- WHAT THIS FILE CHANGES, PER FUNCTION
--
-- 1. ingest_jobs_via_webhook -- the ON CONFLICT DO UPDATE gains a WHERE clause:
--    write only when the resulting description / status / customer_name /
--    start_date / due_date / job_type would actually differ from what is
--    stored, OR when jobs.source is not already 'webhook' (so a job whose
--    source was ever forced away from 'webhook' still self-heals -- see the
--    inline comment). A column the payload does not carry (v_has_x = false)
--    can never trip the guard, because its "new" value is defined as the
--    stored value.
--
--    Side effect, intentional: source / last_synced_at / updated_at now only
--    move on the SAME occasions the guard fires, not on every push. See "Last
--    synced" below -- this is the one behaviour change with a UI-visible
--    consequence and it is called out for the reviewer, not hidden in the
--    diff.
--
--    The exception that guards against a broken column map ("N rows received
--    but none had a job code") can no longer use GET DIAGNOSTICS ROW_COUNT --
--    on a push where every job is already current that count is legitimately
--    0, and a broken map would look the same. A new v_valid_codes (distinct
--    non-empty job codes in the payload, computed in the same scan as the
--    existing presence pass) drives that check and is reported as 'count',
--    exactly the value that field always held before (it happened to equal
--    ROW_COUNT only because every match was always written). A new 'changed'
--    field reports the real ROW_COUNT of the guarded write, for monitoring the
--    fix.
--
-- 2. ingest_quotes_via_webhook -- the QUOTE HEADER upsert is UNCHANGED (still
--    181 verbatim, see "left alone" below). quote_lines is DIFFED instead of
--    wiped and reinserted: a temp table (_q_lines) assigns line_no exactly the
--    way the old INSERT did (row_number() over ord within quote_no), then (a)
--    deletes lines that no longer exist for a touched quote and (b) upserts
--    the rest with a WHERE guard so an unchanged line writes nothing. A line
--    untouched between pushes keeps its id and created_at, which were never
--    stable before this (both were regenerated by the delete+insert on every
--    single push). Response field 'lines' keeps its old meaning (total lines
--    in the payload for touched quotes); 'lines_changed' and 'lines_deleted'
--    are new.
--
-- 3. ingest_invoices_via_webhook -- the INVOICE LEDGER arm is UNCHANGED (see
--    "left alone" below). The JOBS arm gets the same guard as #1 (description /
--    start_date / due_date / source), because it is a second, independent
--    writer of public.jobs -- Tokyo proof below shows it accounts for 70 of
--    the 6,829 job updates in an identical re-push. 'jobs_touched' keeps its
--    old meaning (distinct valid job codes in the payload); 'jobs_changed' is
--    new.
--
--
-- LEFT ALONE, ON PURPOSE, AND WHY (checked against production before writing
-- a line of this file)
--
-- * quotes.last_seen_at (the header upsert) -- po.live_tasks reads it as a
--   presence heartbeat: "... AND q.last_seen_at > (SELECT max(q2.last_seen_at)
--   - c_fresh FROM public.quotes q2 WHERE q2.organisation_id = v_org)" to
--   decide whether a quote is still actively being sent by Infusion (as
--   opposed to accepted/declined and dropped from the export). Every quote's
--   last_seen_at is set to the SAME now() within one call (plpgsql now() is
--   fixed for the transaction), so today every quote touched by a push clears
--   this test. Freezing last_seen_at on an unchanged-content quote would make
--   a genuinely still-live quote look expired and drop it from the chase list
--   in a module this lane does not own (po.*, L2/L3's territory) -- a
--   correctness regression for zero benefit, because last_seen_at would then
--   have to move on every push anyway to keep the heartbeat true, so a content
--   guard on the header buys nothing. Confirmed no other function depends on
--   quotes.updated_at or invoices.sync_token the same way (grepped every
--   function body in public/po/logi for both).
--
-- * ingest_invoices_via_webhook's INVOICE rows (organisation_id, invoice_no) --
--   sync_token must be stamped with the CURRENT push's token on every invoice
--   row the push carries, unconditionally, or the p_final prune ("delete rows
--   not carrying the current token") would delete a row that is genuinely
--   still in the feed just because nothing else about it changed. That is the
--   whole point of the token (173's header) and there is no stable "unchanged"
--   case to skip -- unlike jobs/quotes, sync_token is expected to differ on
--   essentially every push by design. The table is 144 rows, already ~99.7%
--   HOT-updated (n_tup_hot_upd 40,152 of 40,263), 316 autovacuums in 6 days:
--   not a health problem at this size. Guarding it would add risk to the
--   prune contract for no measurable gain.
--
-- * The four 0-scan public.jobs indexes named in the audit survey
--   (jobs_description_idx, jobs_org_status_idx, jobs_leave_type_idx,
--   jobs_org_idx) are index hygiene, not write-path logic, and are already
--   assigned to lane L5's draft so the two lanes do not both touch
--   public.jobs's index set in the same window. Not dropped here. See
--   L4-findings.md.
--
-- * The 24-month quotes age window (Timeium 179) is NOT live on production --
--   confirmed by reading production's actual function body: it equals 181
--   verbatim, and 181 was built on top of 178, not 179, so 179's filter was
--   silently dropped when 181 shipped (2026-08-27). Preserving current
--   behaviour exactly (this lane's hard rule) means this file does NOT
--   reintroduce the age window -- that would be an unrelated behaviour change
--   riding on a performance migration. Flagged here loudly because nobody
--   appears to know the window is gone; a separate migration should decide
--   whether to restore it.
--
--
-- WHY THE OLD wipe+reinsert cannot be "just" content-guarded: quote_lines has
-- no natural key from the export except its position within its quote (there
-- is no line number in the raw payload), so a diff needs *some* materialised
-- line numbering to compare against -- hence the temp table, not a bare
-- ON CONFLICT DO UPDATE the way jobs/invoices get.
--
--
-- TOKYO PROOF (rolled back, never committed; full method, payload construction
-- and every number in L4-findings.md). Same payload, same starting data, OLD
-- body (184/181/186 loaded verbatim from the migration files, confirmed to
-- match pg_get_functiondef on production) vs NEW body (this file), inside one
-- transaction with SAVEPOINTs so no concurrent push on Tokyo could contaminate
-- the comparison:
--
--   Scenario A (identical re-push of Tokyo's own current data):
--     jobs      n_tup_upd  6,829 (OLD) ->     0 (NEW)   [6,759 jobs feed + 70 invoices-feed jobs-arm]
--     quotes    n_tup_upd    351 (OLD) ->   351 (NEW)   [unchanged on purpose, see above]
--     quote_lines ins/del 1,171/1,171 (OLD) -> 0/0 (NEW)
--     invoices  n_tup_upd    130 (OLD) ->   130 (NEW)   [unchanged on purpose, see above]
--   Scenario B (3 real job changes + 1 real line-rate change on top of A):
--     jobs      n_tup_upd  6,759 (OLD) ->     3 (NEW)  -- exactly the 3 changed jobs
--     quote_lines upd          0 (OLD, it deletes+inserts) -> 1 (NEW) -- exactly the 1 changed line
--   Scenario C (one quote loses its last line):
--     quote_lines ins/del 1,170/1,171 (OLD) -> 0 ins / 1 del (NEW) -- exactly the 1 removed line
--
--   Fingerprints (md5 of every row, ordered by natural key, EXCLUDING
--   updated_at + last_synced_at [jobs] / updated_at + last_seen_at [quotes] /
--   id + created_at [quote_lines] / updated_at + last_synced_at + sync_token
--   [invoices] -- these are the columns whose whole job is to record when a
--   row was touched, so they are expected to differ from a churn fix and are
--   excluded the same way 113's fingerprint method excludes updated_at)
--   matched byte-for-byte between OLD and NEW in every scenario:
--     jobs A:     705f6954c8212c52f3c2ee8444267b1b (both)
--     quotes A:   d4058de3f19f04721f28092789e2f2b0 (both)
--     lines A:    c2ec3d0270f5b56cfcb594491cd59029 (both)
--     invoices A: 0d19f5a078f00c97e693bff964083fba (both)
--     jobs B:     66b29a4a33c3d5c16fc751f6814fc507 (both)
--     quotes B:   63877c93db584c76fd3b1c5b62567fdc (both)
--     lines B:    5265203ee8d18f983d280c9715010c13 (both)
--     lines C:    a2a31918238d1aab1e273e3111e3a966 (both)
--
--   A repeat push of an already-converged NEW state wrote 0 rows again on both
--   jobs and quote_lines (checked as a fourth run in the same transaction).
--
--
-- "LAST SYNCED" IN THE ADMIN CONFIGURE PAGE (public/js/configure.js,
-- public/configure.html) -- THE ONE CALL FOR THE REVIEWER, NOT A FOOTNOTE.
-- Today it shows jobs.last_synced_at, which the old code moved to now() on
-- every push for every job, so it always reads "a few minutes ago" whether or
-- not the job's content changed. After this file, a job whose content is
-- stable will stop moving that timestamp -- it will show the last time
-- something about the job actually changed, not the last time the feed ran.
-- Nothing else in this codebase reads jobs.last_synced_at or jobs.updated_at
-- as a freshness/still-in-the-feed signal (checked: only the other sibling
-- ingest_* webhooks reference last_synced_at, each writing its own row, never
-- reading another row's value for a decision; po.search_jobs / po.project_summary
-- use jobs.updated_at only as an ORDER BY tiebreak among same-job_code rows,
-- which cannot occur within one organisation because of the
-- jobs_organisation_id_job_code_key unique constraint). If "last synced" is
-- meant to answer "is the feed still running" rather than "did this job
-- change", that is a product decision to make explicitly, not an argument for
-- reverting the churn fix -- the two meanings cannot both be true of one
-- column without paying the full unconditional-write cost back.
--
--
-- Idempotent: CREATE OR REPLACE, same signatures throughout, so existing
-- grants are untouched by Postgres; the two GRANT/REVOKE lines below just
-- restate what 184/181 already applied, for hygiene.


-- ===========================================================================
-- 1. public.ingest_jobs_via_webhook
-- ===========================================================================
create or replace function public.ingest_jobs_via_webhook(p_api_key text, p_rows jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $function$
declare
    v_org bigint; v_map jsonb;
    v_code_col text; v_desc_col text; v_stat_col text; v_stat_map jsonb;
    v_cust_col text; v_start_col text; v_due_col text; v_type_col text;
    v_has_cust boolean; v_has_start boolean; v_has_due boolean;
    v_has_type boolean; v_has_stat boolean;
    v_rows jsonb;
    v_in integer := 0;
    v_valid_codes integer := 0;
    v_count integer := 0;
    v_keys text;
begin
    if p_api_key is null or length(p_api_key) < 16 then raise exception 'invalid api key'; end if;

    select s.organisation_id, o.jobs_import_map into v_org, v_map
      from public.org_secrets s join public.organisations o on o.id = s.organisation_id
     where s.jobs_webhook_key = p_api_key;
    if v_org is null then raise exception 'unknown api key'; end if;

    v_rows := case when jsonb_typeof(p_rows) = 'array' then p_rows else '[]'::jsonb end;
    v_in   := jsonb_array_length(v_rows);

    v_code_col  := coalesce(v_map->>'code_column',        'job_code');
    v_desc_col  := coalesce(v_map->>'description_column', 'description');
    v_stat_col  := coalesce(v_map->>'status_column',      'status');
    v_stat_map  := coalesce(v_map->'status_map',          '{}'::jsonb);
    v_cust_col  := coalesce(v_map->>'customer_column',    'name');
    v_start_col := coalesce(v_map->>'start_date_column',  'startdate');
    v_due_col   := coalesce(v_map->>'due_date_column',    'duedate');
    v_type_col  := coalesce(v_map->>'type_column',        'jobtype');

    -- 188: v_valid_codes joins the presence pass (one scan) -- how many
    -- DISTINCT job codes this payload actually names. This replaces
    -- GET DIAGNOSTICS ROW_COUNT as the input to the "no job code" exception
    -- and to the response's 'count' field: a guarded UPSERT's ROW_COUNT only
    -- reports rows it WROTE, and on a push where every job is already current
    -- that is legitimately 0 -- using it for the broken-map check would raise
    -- a false exception on a perfectly healthy push.
    select coalesce(bool_or(jsonb_typeof(r) = 'object' and r ? v_cust_col),  false),
           coalesce(bool_or(jsonb_typeof(r) = 'object' and r ? v_start_col), false),
           coalesce(bool_or(jsonb_typeof(r) = 'object' and r ? v_due_col),   false),
           coalesce(bool_or(jsonb_typeof(r) = 'object' and r ? v_type_col),  false),
           coalesce(bool_or(jsonb_typeof(r) = 'object' and r ? v_stat_col),  false),
           count(distinct nullif(trim(r->>v_code_col), ''))
      into v_has_cust, v_has_start, v_has_due, v_has_type, v_has_stat, v_valid_codes
      from jsonb_array_elements(v_rows) as t(r);

    insert into public.jobs (
        organisation_id, job_code, description, status, source, last_synced_at,
        customer_name, start_date, due_date, job_type
    )
    select distinct on (code)
        v_org,
        code,
        nullif(trim(coalesce(r->>v_desc_col, '')), ''),
        public._canonical_job_status(r->>v_stat_col, v_stat_map),
        'webhook',
        now(),
        nullif(trim(coalesce(r->>v_cust_col, '')), ''),
        public._parse_infusion_date(r->>v_start_col),
        public._parse_infusion_date(r->>v_due_col),
        nullif(upper(trim(coalesce(r->>v_type_col, ''))), '')
    from jsonb_array_elements(v_rows) with ordinality as t(r, rn)
    cross join lateral (select trim(r->>v_code_col) as code) c
    where length(coalesce(code, '')) > 0
    order by code, rn desc
    on conflict (organisation_id, job_code) do update
        set description    = coalesce(excluded.description, jobs.description),
            status         = case when v_has_stat  then excluded.status        else jobs.status        end,
            source         = 'webhook',
            last_synced_at = now(),
            updated_at     = now(),
            customer_name  = case when v_has_cust  then excluded.customer_name else jobs.customer_name end,
            start_date     = case when v_has_start then excluded.start_date    else jobs.start_date    end,
            due_date       = case when v_has_due   then excluded.due_date      else jobs.due_date      end,
            job_type       = case when v_has_type  then excluded.job_type      else jobs.job_type      end
        -- 188: write only when something this payload controls would actually
        -- change the stored row. source is folded in so a job whose source was
        -- ever forced away from 'webhook' still self-heals exactly as before --
        -- it just no longer costs a write on every push where it is already
        -- correct. A column the payload does not carry (v_has_x = false) can
        -- never trip the guard, because its "new" value above is defined as
        -- the stored value, which is never distinct from itself.
        where jobs.source is distinct from 'webhook'
           or coalesce(excluded.description, jobs.description) is distinct from jobs.description
           or (v_has_stat  and excluded.status         is distinct from jobs.status)
           or (v_has_cust  and excluded.customer_name  is distinct from jobs.customer_name)
           or (v_has_start and excluded.start_date     is distinct from jobs.start_date)
           or (v_has_due   and excluded.due_date       is distinct from jobs.due_date)
           or (v_has_type  and excluded.job_type        is distinct from jobs.job_type);

    get diagnostics v_count = row_count;

    select string_agg(k, ', ' order by k) into v_keys
      from jsonb_object_keys(case when jsonb_typeof(v_rows->0) = 'object'
                                  then v_rows->0 else '{}'::jsonb end) as k;

    if v_in > 0 and v_valid_codes = 0 then
        raise exception
            'jobs webhook: % row(s) received but none had a job code. '
            'Looked for key "%" (organisations.jobs_import_map -> code_column). '
            'First row actually has: [%]',
            v_in, v_code_col, coalesce(v_keys, '(no keys)');
    end if;

    if v_in > 0 and not v_has_stat then
        raise warning
            'jobs webhook: % row(s) received, none carrying a status. Statuses '
            'left unchanged. Looked for key "%" '
            '(organisations.jobs_import_map -> status_column). '
            'First row actually has: [%]',
            v_in, v_stat_col, coalesce(v_keys, '(no keys)');
    end if;

    return jsonb_build_object(
        'ok', true, 'organisation_id', v_org,
        'received', v_in, 'count', v_valid_codes, 'changed', v_count,
        'columns_in_payload', jsonb_build_object(
            'status', v_has_stat, 'customer_name', v_has_cust,
            'start_date', v_has_start, 'due_date', v_has_due,
            'job_type', v_has_type));
end$function$;

grant execute on function public.ingest_jobs_via_webhook(text, jsonb) to anon, authenticated;


-- ===========================================================================
-- 2. public.ingest_quotes_via_webhook -- header untouched, quote_lines diffed
-- ===========================================================================
create or replace function public.ingest_quotes_via_webhook(
    p_api_key text,
    p_rows    jsonb default '[]'::jsonb
)
returns jsonb language plpgsql security definer set search_path = public as $function$
declare
    v_org bigint; v_map jsonb;
    v_no_col text; v_name_col text; v_title_col text; v_desc_col text;
    v_qty_col text; v_rate_col text; v_ext_col text; v_job_col text;
    v_stat_col text; v_date_col text; v_rep_col text;
    v_quotes integer := 0; v_lines integer := 0;
    v_lines_changed integer := 0; v_lines_deleted integer := 0;
begin
    if p_api_key is null or length(p_api_key) < 16 then raise exception 'invalid api key'; end if;

    select s.organisation_id, o.quotes_import_map into v_org, v_map
      from public.org_secrets s join public.organisations o on o.id = s.organisation_id
     where s.quotes_webhook_key = p_api_key;
    if v_org is null then raise exception 'unknown api key'; end if;

    v_no_col    := coalesce(v_map->>'quote_column',       'invnum');
    v_name_col  := coalesce(v_map->>'debtor_column',      'name');
    v_title_col := coalesce(v_map->>'title_column',       'invtitle');
    v_desc_col  := coalesce(v_map->>'description_column', 'desc');
    v_qty_col   := coalesce(v_map->>'qty_column',         'qty');
    v_rate_col  := coalesce(v_map->>'rate_column',        'rate');
    v_ext_col   := coalesce(v_map->>'extended_column',    'extend');
    v_job_col   := coalesce(v_map->>'job_column',         'jobid');
    v_stat_col  := coalesce(v_map->>'status_column',      'status');
    v_date_col  := coalesce(v_map->>'date_column',        'date');
    v_rep_col   := coalesce(v_map->>'rep_column',         'rep2');

    if to_regclass('pg_temp._q_rows') is not null then execute 'drop table _q_rows'; end if;
    create temporary table _q_rows on commit drop as
    select trim(r->>v_no_col)                                       as quote_no,
           nullif(trim(coalesce(r->>v_name_col,  '')), '')          as debtor_name,
           nullif(trim(coalesce(r->>v_title_col, '')), '')          as title,
           nullif(trim(coalesce(r->>v_desc_col,  '')), '')          as description,
           public._parse_infusion_number(r->>v_qty_col)             as qty,
           public._parse_infusion_number(r->>v_rate_col)            as rate,
           public._parse_infusion_number(r->>v_ext_col)             as extended,
           nullif(trim(coalesce(r->>v_job_col,   '')), '')          as job_code,
           nullif(upper(trim(coalesce(r->>v_stat_col, ''))), '')    as status,
           nullif(trim(coalesce(r->>v_stat_col, '')), '')           as raw_status,
           public._parse_infusion_date(r->>v_date_col)              as quote_date,
           nullif(upper(trim(coalesce(r->>v_rep_col, ''))), '')     as rep_code,
           rn                                                        as ord
      from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality as t(r, rn);

    delete from _q_rows where coalesce(quote_no, '') = '';

    if not exists (select 1 from _q_rows) then
        return jsonb_build_object('ok', true, 'quotes', 0, 'lines', 0,
                                  'lines_changed', 0, 'lines_deleted', 0,
                                  'note', 'no rows with a quote number');
    end if;

    -- Header logic is 181 VERBATIM -- UNCHANGED by 188. quotes.last_seen_at is
    -- a presence heartbeat po.live_tasks reads as "still in the feed"; it must
    -- move on every push regardless of content, so guarding this upsert would
    -- fire on every row every push anyway and buys nothing while risking that
    -- dependency. See the file header for the full explanation.
    insert into public.quotes as q (
        organisation_id, quote_no, title, debtor_name, job_code,
        status, raw_status, quote_date, rep_code, line_count, total_value,
        first_seen_at, last_seen_at)
    select v_org,
           h.quote_no, h.title, h.debtor_name, h.job_code,
           h.status, h.raw_status, h.quote_date, h.rep_code,
           agg.n, agg.total,
           now(), now()
      from (select distinct on (quote_no)
                   quote_no, title, debtor_name, job_code, status, raw_status,
                   quote_date, rep_code
              from _q_rows
             order by quote_no, ord desc) h
      join (select quote_no, count(*) as n, sum(coalesce(extended, 0)) as total
              from _q_rows group by quote_no) agg on agg.quote_no = h.quote_no
    on conflict (organisation_id, quote_no) do update
        set title        = excluded.title,
            debtor_name  = excluded.debtor_name,
            job_code     = excluded.job_code,
            status       = excluded.status,
            raw_status   = excluded.raw_status,
            quote_date   = excluded.quote_date,
            rep_code     = coalesce(excluded.rep_code, q.rep_code),
            line_count   = excluded.line_count,
            total_value  = excluded.total_value,
            last_seen_at = now(),
            updated_at   = now();
    get diagnostics v_quotes = row_count;

    -- 188: quote_lines is DIFFED instead of wiped and reinserted. Same net
    -- effect as before ("only quotes present in THIS payload are touched",
    -- "line identity is position within the quote") -- the old delete-then-
    -- insert rewrote every line of every touched quote on every push
    -- (598k ins / 597k del over 6 days for a table that only ever holds
    -- ~1,100 rows). _q_lines assigns line_no exactly the way the old INSERT
    -- did, so the delete and the upsert below agree with it byte-for-byte.
    if to_regclass('pg_temp._q_lines') is not null then execute 'drop table _q_lines'; end if;
    create temporary table _q_lines on commit drop as
    select r.quote_no,
           row_number() over (partition by r.quote_no order by r.ord) as line_no,
           r.description, r.qty, r.rate, r.extended
      from _q_rows r;

    select count(*) into v_lines from _q_lines;

    -- 1. Remove lines that no longer exist for a touched quote (fewer lines
    -- this push, or the set changed shape). Only quotes present in THIS
    -- payload are touched, same as before.
    delete from public.quote_lines l
     where l.organisation_id = v_org
       and l.quote_no in (select distinct quote_no from _q_rows)
       and not exists (
             select 1 from _q_lines n
              where n.quote_no = l.quote_no and n.line_no = l.line_no);
    get diagnostics v_lines_deleted = row_count;

    -- 2. Insert new lines / update the ones whose content actually changed. A
    -- line untouched between pushes now writes nothing, so it keeps its id
    -- and created_at instead of both cycling on every 15-minute push --
    -- neither was ever a stable identity before this. Checked: logi.attach_quote,
    -- logi.packing_queue and logi.start_pack_job all read quote_lines by
    -- (organisation_id, quote_no) only, never by id, so nothing relies on id
    -- surviving a push (it never did before either).
    insert into public.quote_lines (
        organisation_id, quote_no, line_no, description, qty, rate, extended)
    select v_org, n.quote_no, n.line_no, n.description, n.qty, n.rate, n.extended
      from _q_lines n
    on conflict (organisation_id, quote_no, line_no) do update
        set description = excluded.description,
            qty         = excluded.qty,
            rate        = excluded.rate,
            extended    = excluded.extended
        where quote_lines.description is distinct from excluded.description
           or quote_lines.qty         is distinct from excluded.qty
           or quote_lines.rate        is distinct from excluded.rate
           or quote_lines.extended    is distinct from excluded.extended;
    get diagnostics v_lines_changed = row_count;

    return jsonb_build_object(
        'ok', true,
        'quotes', v_quotes,
        'lines', v_lines,
        'lines_changed', v_lines_changed,
        'lines_deleted', v_lines_deleted,
        'with_rep', (select count(*) from (select distinct on (quote_no) rep_code
                                             from _q_rows order by quote_no, ord desc) d
                      where d.rep_code is not null),
        'per_quote', (select jsonb_object_agg(quote_no, n)
                        from (select quote_no, count(*) as n
                                from _q_rows group by quote_no
                               order by quote_no limit 200) x));
end$function$;

revoke all on function public.ingest_quotes_via_webhook(text, jsonb) from public;
grant execute on function public.ingest_quotes_via_webhook(text, jsonb) to anon, authenticated;


-- ===========================================================================
-- 3. public.ingest_invoices_via_webhook -- ledger arm untouched, jobs arm diffed
-- ===========================================================================
create or replace function public.ingest_invoices_via_webhook(
    p_api_key    text,
    p_rows       jsonb   default '[]'::jsonb,
    p_sync_token text    default null,
    p_final      boolean default false
)
returns jsonb language plpgsql security definer set search_path = public as $function$
declare
    v_org bigint; v_map jsonb;
    v_job_col text; v_title_col text; v_start_col text;
    v_due_col text;
    v_inv_col text; v_invdate_col text; v_invstat_col text;
    v_quote_col text; v_total_col text;
    v_has_start boolean; v_has_due boolean;
    v_has_quote boolean; v_has_total boolean;
    v_invoices integer := 0; v_jobs integer := 0; v_jobs_touched integer := 0;
    v_pruned integer := 0;
begin
    if p_api_key is null or length(p_api_key) < 16 then raise exception 'invalid api key'; end if;

    select s.organisation_id, o.invoices_import_map into v_org, v_map
      from public.org_secrets s join public.organisations o on o.id = s.organisation_id
     where s.invoices_webhook_key = p_api_key;
    if v_org is null then raise exception 'unknown api key'; end if;

    v_job_col     := coalesce(v_map->>'job_column',            'jobid');
    v_title_col   := coalesce(v_map->>'title_column',          'title');
    v_start_col   := coalesce(v_map->>'start_date_column',     'startdate');
    v_due_col     := coalesce(v_map->>'due_date_column',       'duedate');
    v_quote_col   := coalesce(v_map->>'quote_total_column',    'quotetotal');
    v_total_col   := coalesce(v_map->>'invoice_total_column',  'invtotal');
    v_inv_col     := coalesce(v_map->>'invoice_column',        'invnum');
    v_invdate_col := coalesce(v_map->>'invoice_date_column',   'invdate');
    v_invstat_col := coalesce(v_map->>'invoice_status_column', 'invstatus');

    -- 188: v_jobs_touched (distinct job codes this push names) joins the
    -- presence pass -- one scan. 'jobs_touched' keeps its old meaning (it was
    -- always this count, since every named job used to be written
    -- unconditionally); 'jobs_changed' below is new.
    select coalesce(bool_or(jsonb_typeof(r) = 'object' and r ? v_start_col), false),
           coalesce(bool_or(jsonb_typeof(r) = 'object' and r ? v_due_col),   false),
           coalesce(bool_or(jsonb_typeof(r) = 'object' and r ? v_quote_col), false),
           coalesce(bool_or(jsonb_typeof(r) = 'object' and r ? v_total_col), false),
           count(distinct nullif(trim(r->>v_job_col), ''))
      into v_has_start, v_has_due, v_has_quote, v_has_total, v_jobs_touched
      from jsonb_array_elements(
             case when jsonb_typeof(p_rows) = 'array' then p_rows else '[]'::jsonb end
           ) as t(r);

    ----------------------------------------------------------------- invoices --
    -- UNCHANGED from 186 -- deliberately left unconditional. sync_token has to
    -- move to the current p_sync_token on every invoice row this push
    -- carries, or the p_final prune would delete a row that is genuinely
    -- still in the feed just because nothing else about it changed. See the
    -- file header. Table is 144 rows, already ~99.7% HOT-updated: not a
    -- health problem at this size.
    with src as (
        select
            trim(r->>v_inv_col)                          as invoice_no,
            public._parse_infusion_date(r->>v_invdate_col) as invoice_date,
            r->>v_invstat_col                            as raw_status,
            nullif(trim(coalesce(r->>v_job_col, '')), '') as job_code,
            public._parse_infusion_money(r->>v_quote_col) as quote_total,
            public._parse_infusion_money(r->>v_total_col) as invoice_total,
            rn
        from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality as t(r, rn)
    ),
    picked as (
        select distinct on (invoice_no)
               invoice_no, invoice_date, raw_status, job_code, quote_total, invoice_total
        from src
        where length(coalesce(invoice_no, '')) > 0
        order by invoice_no, rn desc
    )
    insert into public.invoices (
        organisation_id, invoice_no, invoice_date, status, raw_status, job_code,
        quote_total, invoice_total, sync_token, last_synced_at
    )
    select v_org, p.invoice_no, p.invoice_date,
           public._canonical_invoice_status(p.raw_status),
           nullif(trim(coalesce(p.raw_status, '')), ''),
           p.job_code, p.quote_total, p.invoice_total, p_sync_token, now()
    from picked p
    on conflict (organisation_id, invoice_no) do update
        set invoice_date   = excluded.invoice_date,
            status         = excluded.status,
            raw_status     = excluded.raw_status,
            job_code       = excluded.job_code,
            quote_total    = case when v_has_quote then excluded.quote_total   else invoices.quote_total   end,
            invoice_total  = case when v_has_total then excluded.invoice_total else invoices.invoice_total end,
            sync_token     = excluded.sync_token,
            last_synced_at = now(),
            updated_at     = now();
    get diagnostics v_invoices = row_count;

    --------------------------------------------------------------------- jobs --
    -- 188: the jobs arm gets the SAME content-diff guard as
    -- ingest_jobs_via_webhook. Unlike sync_token above, nothing reads "was
    -- this job's row touched by the invoices feed" as a freshness signal
    -- (checked: no function references jobs.last_synced_at or jobs.updated_at
    -- that way), so nothing blocks the same fix here. Tokyo proof: this arm
    -- alone wrote 70 of the 6,829 job-row updates in an identical re-push
    -- before this fix, and 0 after (once the jobs feed had already made those
    -- 70 rows current).
    with src as (
        select
            nullif(trim(coalesce(r->>v_job_col, '')), '')  as job_code,
            nullif(trim(coalesce(r->>v_title_col, '')), '') as title,
            public._parse_infusion_date(r->>v_start_col)    as start_date,
            public._parse_infusion_date(r->>v_due_col)      as due_date,
            public._parse_infusion_date(r->>v_invdate_col)  as invoice_date,
            rn
        from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality as t(r, rn)
    ),
    latest as (
        select distinct on (job_code) job_code, title, start_date, due_date
        from src
        where length(coalesce(job_code, '')) > 0
        order by job_code, invoice_date desc nulls last, rn desc
    )
    insert into public.jobs (
        organisation_id, job_code, description,
        start_date, due_date, source, last_synced_at
    )
    select v_org, l.job_code, l.title,
           l.start_date, l.due_date, 'webhook', now()
    from latest l
    on conflict (organisation_id, job_code) do update
        set description    = coalesce(excluded.description, jobs.description),
            start_date     = case when v_has_start then excluded.start_date else jobs.start_date end,
            due_date       = case when v_has_due   then excluded.due_date   else jobs.due_date   end,
            source         = 'webhook',
            last_synced_at = now(),
            updated_at     = now()
        where jobs.source is distinct from 'webhook'
           or coalesce(excluded.description, jobs.description) is distinct from jobs.description
           or (v_has_start and excluded.start_date is distinct from jobs.start_date)
           or (v_has_due   and excluded.due_date   is distinct from jobs.due_date);
    get diagnostics v_jobs = row_count;

    -------------------------------------------------------------------- prune --
    -- UNCHANGED from 186.
    if p_final and p_sync_token is not null then
        delete from public.invoices
         where organisation_id = v_org
           and sync_token is distinct from p_sync_token;
        get diagnostics v_pruned = row_count;
    end if;

    return jsonb_build_object(
        'ok', true,
        'organisation_id', v_org,
        'invoices', v_invoices,
        'jobs_touched', v_jobs_touched,
        'jobs_changed', v_jobs,
        'pruned', v_pruned,
        'finalised', (p_final and p_sync_token is not null),
        'columns_in_payload', jsonb_build_object(
            'start_date', v_has_start, 'due_date', v_has_due,
            'quote_total', v_has_quote, 'invoice_total', v_has_total)
    );
end$function$;

grant execute on function public.ingest_invoices_via_webhook(text, jsonb, text, boolean) to anon, authenticated;


-- ===========================================================================
-- Structural self-checks. Cannot fingerprint live data here (calling any of
-- these three functions for real would need a live org_secrets key and would
-- perform a real push) -- the data-identity proof is the Tokyo run above and
-- in L4-findings.md. What CAN be checked safely at apply time: the objects
-- this file depends on still exist with the shape it assumes, and the guard
-- text actually landed. Raises and aborts the whole migration on any mismatch.
-- ===========================================================================
do $$
begin
    if not exists (
        select 1 from pg_constraint
         where conrelid = 'public.quote_lines'::regclass
           and conname = 'quote_lines_organisation_id_quote_no_line_no_key'
    ) then
        raise exception '188: quote_lines is missing the (organisation_id, quote_no, line_no) '
            'unique constraint the new ON CONFLICT target relies on -- plpgsql does not '
            'validate an ON CONFLICT target at CREATE time, so this would only fail the '
            'first time a quote actually pushes.';
    end if;

    if not exists (
        select 1 from pg_trigger
         where tgrelid = 'public.jobs'::regclass
           and tgname = 'trg_jobs_updated_at'
           and not tgisinternal
    ) then
        raise exception '188: trg_jobs_updated_at on public.jobs is missing -- the header''s '
            'account of updated_at behaviour (BEFORE UPDATE FOR EACH ROW, fires once per '
            'row actually written) assumes this trigger exists.';
    end if;

    if position('jobs.source is distinct from' in
                pg_get_functiondef('public.ingest_jobs_via_webhook(text,jsonb)'::regprocedure)) = 0
    then
        raise exception '188: ingest_jobs_via_webhook does not contain the expected write guard.';
    end if;

    if position('jobs.source is distinct from' in
                pg_get_functiondef('public.ingest_invoices_via_webhook(text,jsonb,text,boolean)'::regprocedure)) = 0
    then
        raise exception '188: ingest_invoices_via_webhook does not contain the expected jobs-arm write guard.';
    end if;

    if position('_q_lines' in
                pg_get_functiondef('public.ingest_quotes_via_webhook(text,jsonb)'::regprocedure)) = 0
    then
        raise exception '188: ingest_quotes_via_webhook does not contain the expected quote_lines diff.';
    end if;
end$$;

commit;

notify pgrst, 'reload schema';

-- The SQL editor shows only the last result: expect t | t | t
select position('jobs.source is distinct from' in pg_get_functiondef('public.ingest_jobs_via_webhook(text,jsonb)'::regprocedure)) > 0 as jobs_guard,
       position('_q_lines' in pg_get_functiondef('public.ingest_quotes_via_webhook(text,jsonb)'::regprocedure)) > 0 as quote_lines_diff,
       position('jobs.source is distinct from' in pg_get_functiondef('public.ingest_invoices_via_webhook(text,jsonb,text,boolean)'::regprocedure)) > 0 as invoices_jobs_guard;
