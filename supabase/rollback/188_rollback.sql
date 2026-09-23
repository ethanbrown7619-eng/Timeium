-- ============================================================================
-- 188_rollback.sql - UNDO Timeium 188 (feeds write only changes).
--
-- The three Infusion feed functions EXACTLY as production (Sydney) ran them
-- on 2026-09-24, captured with pg_get_functiondef immediately BEFORE 188 was
-- applied. Pasting this file puts the jobs, quotes and invoices feeds back to
-- rewriting every row each push. 188 changed no stored data, so nothing else
-- needs undoing. Not a numbered migration - keep for emergencies only.
-- ASCII-only.
-- ============================================================================

begin;

CREATE OR REPLACE FUNCTION public.ingest_invoices_via_webhook(p_api_key text, p_rows jsonb DEFAULT '[]'::jsonb, p_sync_token text DEFAULT NULL::text, p_final boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_org bigint; v_map jsonb;
    v_job_col text; v_title_col text; v_start_col text;
    v_due_col text;
    v_inv_col text; v_invdate_col text; v_invstat_col text;
    v_quote_col text; v_total_col text;
    v_has_start boolean; v_has_due boolean;
    v_has_quote boolean; v_has_total boolean;
    v_invoices integer := 0; v_jobs integer := 0; v_pruned integer := 0;
begin
    if p_api_key is null or length(p_api_key) < 16 then raise exception 'invalid api key'; end if;

    select s.organisation_id, o.invoices_import_map into v_org, v_map
      from public.org_secrets s join public.organisations o on o.id = s.organisation_id
     where s.invoices_webhook_key = p_api_key;
    if v_org is null then raise exception 'unknown api key'; end if;

    -- Defaults are the live export's own column names, so switching this on
    -- needs no invoices_import_map row at all.
    v_job_col     := coalesce(v_map->>'job_column',            'jobid');
    v_title_col   := coalesce(v_map->>'title_column',          'title');
    v_start_col   := coalesce(v_map->>'start_date_column',     'startdate');
    v_due_col     := coalesce(v_map->>'due_date_column',       'duedate');
    v_quote_col   := coalesce(v_map->>'quote_total_column',    'quotetotal');
    v_total_col   := coalesce(v_map->>'invoice_total_column',  'invtotal');
    v_inv_col     := coalesce(v_map->>'invoice_column',        'invnum');
    v_invdate_col := coalesce(v_map->>'invoice_date_column',   'invdate');
    v_invstat_col := coalesce(v_map->>'invoice_status_column', 'invstatus');
    -- 185: job_status_column and job_type_column are GONE. Those two columns
    -- belong to ingest_jobs_via_webhook (184) - see the header. The mappings go
    -- with the writes so a stale invoices_import_map entry cannot quietly turn
    -- them back on.
    -- NOTE: there is deliberately no `name` mapping. See 173's header.

    -- 185, borrowed from 180: which date columns is this payload actually
    -- carrying? One pass, whole payload. Present in ANY row means the field is
    -- in play for this call, so a row that omits it is a genuine clear. Present
    -- in NO row means the sender is not sending it and the stored value is left
    -- alone rather than nulled.
    -- 186: the two money columns join the presence test. The export swapped
    -- quotetotal for invtotal on 2026-09-17; a plain write of the missing one
    -- would have nulled quote_total on every row of the ledger, 200 OK.
    select coalesce(bool_or(jsonb_typeof(r) = 'object' and r ? v_start_col), false),
           coalesce(bool_or(jsonb_typeof(r) = 'object' and r ? v_due_col),   false),
           coalesce(bool_or(jsonb_typeof(r) = 'object' and r ? v_quote_col), false),
           coalesce(bool_or(jsonb_typeof(r) = 'object' and r ? v_total_col), false)
      into v_has_start, v_has_due, v_has_quote, v_has_total
      from jsonb_array_elements(
             case when jsonb_typeof(p_rows) = 'array' then p_rows else '[]'::jsonb end
           ) as t(r);

    ----------------------------------------------------------------- invoices --
    -- 186: invoice_total joins quote_total, and both only write when the
    -- payload carried the key (see the presence pass above). Otherwise as 174.
    -- distinct on: a ledger push can legitimately repeat an invoice number
    -- across chunks; the later row in the payload wins. The money columns ride
    -- that same rule, so they always agree with the date/status stored beside
    -- them.
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
    -- 185: status and job_type are GONE from both the insert and the update -
    -- they belong to the jobs feed (184). start_date and due_date survive but
    -- only write when the payload actually carried the key.
    --
    -- Only the LATEST invoice per job writes the job columns (see 173's header).
    -- customer_name is absent from both the insert and the update: this feed
    -- must never touch it - jobs sends the CUSTOMER, invoices send the DEBTOR.
    --
    -- A job seen for the FIRST time here gets its status from the column
    -- default (030: not null default 'ACTIVE'), which is what this feed used to
    -- write for a missing status anyway. It gets no type at all, and waits for
    -- the jobs feed to supply one.
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
            updated_at     = now();
    get diagnostics v_jobs = row_count;

    -------------------------------------------------------------------- prune --
    -- UNCHANGED from 174. Only on the final chunk, and only when a token was
    -- supplied: without one every row would look stale and the whole ledger
    -- would be deleted.
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
        'jobs_touched', v_jobs,
        'pruned', v_pruned,
        'finalised', (p_final and p_sync_token is not null),
        -- 185: say which date columns the payload carried, the way 184 does.
        -- A feed that stops sending a column should be visible in its own
        -- response rather than inferred from damage weeks later.
        'columns_in_payload', jsonb_build_object(
            'start_date', v_has_start, 'due_date', v_has_due,
            'quote_total', v_has_quote, 'invoice_total', v_has_total)
    );
end$function$
;
CREATE OR REPLACE FUNCTION public.ingest_jobs_via_webhook(p_api_key text, p_rows jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_org bigint; v_map jsonb;
    v_code_col text; v_desc_col text; v_stat_col text; v_stat_map jsonb;
    v_cust_col text; v_start_col text; v_due_col text; v_type_col text;
    v_has_cust boolean; v_has_start boolean; v_has_due boolean;
    v_has_type boolean; v_has_stat boolean;
    v_rows jsonb;
    v_in integer := 0;
    v_count integer := 0;
    v_keys text;
begin
    if p_api_key is null or length(p_api_key) < 16 then raise exception 'invalid api key'; end if;

    select s.organisation_id, o.jobs_import_map into v_org, v_map
      from public.org_secrets s join public.organisations o on o.id = s.organisation_id
     where s.jobs_webhook_key = p_api_key;
    if v_org is null then raise exception 'unknown api key'; end if;

    -- A non-array p_rows (an object, a string, null) is treated as an empty
    -- payload rather than allowed to blow up jsonb_array_elements below.
    v_rows := case when jsonb_typeof(p_rows) = 'array' then p_rows else '[]'::jsonb end;
    v_in   := jsonb_array_length(v_rows);

    v_code_col  := coalesce(v_map->>'code_column',        'job_code');
    v_desc_col  := coalesce(v_map->>'description_column', 'description');
    v_stat_col  := coalesce(v_map->>'status_column',      'status');
    v_stat_map  := coalesce(v_map->'status_map',          '{}'::jsonb);
    v_cust_col  := coalesce(v_map->>'customer_column',    'name');
    v_start_col := coalesce(v_map->>'start_date_column',  'startdate');
    v_due_col   := coalesce(v_map->>'due_date_column',    'duedate');
    -- 184: job_type is this feed's again (header 1). The default is the key the
    -- 2026-09-14 sender uses, so no jobs_import_map change is needed to switch
    -- it on; `type_column` stays available if a sender's casing ever differs.
    v_type_col  := coalesce(v_map->>'type_column',        'jobtype');

    -- Which of these is this payload actually carrying? One pass, whole
    -- payload: present in ANY row means the field is in play for this call, so
    -- a row that omits it is a genuine clear. Present in NO row means the
    -- sender is not sending it at all and the stored value is left alone.
    --
    -- 184 adds job_type (new to this feed) and status -- which used to be
    -- written unconditionally, and that is exactly what let a key rename
    -- flatten every job to ACTIVE. See header 2.
    select coalesce(bool_or(jsonb_typeof(r) = 'object' and r ? v_cust_col),  false),
           coalesce(bool_or(jsonb_typeof(r) = 'object' and r ? v_start_col), false),
           coalesce(bool_or(jsonb_typeof(r) = 'object' and r ? v_due_col),   false),
           coalesce(bool_or(jsonb_typeof(r) = 'object' and r ? v_type_col),  false),
           coalesce(bool_or(jsonb_typeof(r) = 'object' and r ? v_stat_col),  false)
      into v_has_cust, v_has_start, v_has_due, v_has_type, v_has_stat
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
        -- Upper-cased on ingest (169's rule for this column) so downstream
        -- filters match a literal like 'SPARES' without caring about the
        -- sender's casing. Asterisk forms such as *STD* are stored as sent --
        -- the vocabulary is Infusion's and is not ours to normalise.
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
            job_type       = case when v_has_type  then excluded.job_type      else jobs.job_type      end;

    get diagnostics v_count = row_count;

    -- The first row's keys, named by both diagnostics below so a broken map can
    -- be repaired without needing a repro.
    select string_agg(k, ', ' order by k) into v_keys
      from jsonb_object_keys(case when jsonb_typeof(v_rows->0) = 'object'
                                  then v_rows->0 else '{}'::jsonb end) as k;

    -- Rows arrived and none of them had a job code. That is a broken column
    -- map, never a legitimate payload, and it must not look like success.
    if v_in > 0 and v_count = 0 then
        raise exception
            'jobs webhook: % row(s) received but none had a job code. '
            'Looked for key "%" (organisations.jobs_import_map -> code_column). '
            'First row actually has: [%]',
            v_in, v_code_col, coalesce(v_keys, '(no keys)');
    end if;

    -- Rows arrived and none of them carried a status. Stored statuses were left
    -- alone above rather than flattened to ACTIVE, so this is not data loss --
    -- but it is almost certainly a broken map, and until 184 it was invisible.
    -- Header 2 says why this warns rather than raising.
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
        'received', v_in, 'count', v_count,
        'columns_in_payload', jsonb_build_object(
            'status', v_has_stat, 'customer_name', v_has_cust,
            'start_date', v_has_start, 'due_date', v_has_due,
            'job_type', v_has_type));
end$function$
;
CREATE OR REPLACE FUNCTION public.ingest_quotes_via_webhook(p_api_key text, p_rows jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_org bigint; v_map jsonb;
    v_no_col text; v_name_col text; v_title_col text; v_desc_col text;
    v_qty_col text; v_rate_col text; v_ext_col text; v_job_col text;
    v_stat_col text; v_date_col text; v_rep_col text;
    v_quotes integer := 0; v_lines integer := 0;
begin
    if p_api_key is null or length(p_api_key) < 16 then raise exception 'invalid api key'; end if;

    select s.organisation_id, o.quotes_import_map into v_org, v_map
      from public.org_secrets s join public.organisations o on o.id = s.organisation_id
     where s.quotes_webhook_key = p_api_key;
    if v_org is null then raise exception 'unknown api key'; end if;

    -- Defaults are the export's own column names, so switching this on needs no
    -- quotes_import_map row at all.
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

    -- One pass over the payload, normalised once and reused by both writes.
    -- Ordinality is the line order: it is the ONLY line identity the export
    -- provides, so it has to be taken from the payload's own row order.
    --
    -- A temp table rather than CTEs on purpose: the lines are DELETEd and then
    -- INSERTed, and doing both in one statement risks the insert colliding with
    -- rows the delete has not yet made invisible to it. Two statements over one
    -- materialised set is the version with no sharp edge.
    --
    -- `on commit drop` clears it at the end of the request; this only matters if
    -- someone calls the function twice inside one transaction by hand. Guarded
    -- rather than `drop table if exists`, which logs a NOTICE on every single
    -- webhook call for a condition that is normal.
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
           -- Upper-cased for the same reason status is: it is compared, not
           -- displayed raw. "" becomes null, never an empty string, so the
           -- strict filter treats "no rep" and "unknown rep" as one state.
           nullif(upper(trim(coalesce(r->>v_rep_col, ''))), '')     as rep_code,
           rn                                                        as ord
      from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality as t(r, rn);

    -- A row with no quote number cannot be filed anywhere. Dropped, not raised:
    -- one malformed row must not cost the whole push.
    delete from _q_rows where coalesce(quote_no, '') = '';

    if not exists (select 1 from _q_rows) then
        return jsonb_build_object('ok', true, 'quotes', 0, 'lines', 0,
                                  'note', 'no rows with a quote number');
    end if;

    -- The header, one row per quote. Header fields are repeated on every line of
    -- a quote, so the LAST occurrence wins - the same last-row-wins rule 173 and
    -- 174 use, chosen there so the stored fields cannot disagree with each other.
    -- Totals come from the lines in this same payload, never from a header
    -- column, so what the app shows always adds up to what it lists.
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
            -- COALESCE, unlike its neighbours: an export that stops sending
            -- rep2 (or a flow edited back by mistake) would otherwise NULL the
            -- rep on every quote it touches and empty the Spares Quotes tab -
            -- 169's "one column, one writer" lesson, where a field absent from
            -- the payload silently blanked live data and returned 200 OK. A rep
            -- can still be CHANGED, just never erased by absence.
            rep_code     = coalesce(excluded.rep_code, q.rep_code),
            line_count   = excluded.line_count,
            total_value  = excluded.total_value,
            -- first_seen_at is deliberately NOT touched: it records when this
            -- quote first reached the ERP, which is a fact about the past.
            last_seen_at = now(),
            updated_at   = now();
    get diagnostics v_quotes = row_count;

    -- Lines are REPLACED, not merged. Without a line identifier from the export
    -- there is nothing to match on, and a merge would silently accumulate every
    -- historical edit of a quote as extra lines. Only quotes present in THIS
    -- payload are touched.
    delete from public.quote_lines l
     where l.organisation_id = v_org
       and l.quote_no in (select distinct quote_no from _q_rows);

    insert into public.quote_lines (
        organisation_id, quote_no, line_no, description, qty, rate, extended)
    select v_org, r.quote_no,
           row_number() over (partition by r.quote_no order by r.ord),
           r.description, r.qty, r.rate, r.extended
      from _q_rows r;
    get diagnostics v_lines = row_count;

    return jsonb_build_object(
        'ok', true,
        'quotes', v_quotes,
        'lines', v_lines,
        -- How many of this push carried a rep at all. The one number that says
        -- whether the Power Automate change actually landed: 0 here with a
        -- non-zero quote count means the flow is still sending the old shape.
        'with_rep', (select count(*) from (select distinct on (quote_no) rep_code
                                             from _q_rows order by quote_no, ord desc) d
                      where d.rep_code is not null),
        -- Per-quote counts, so the sender can be checked against the one
        -- constraint this design places on it: all of a quote's lines must
        -- arrive in the same post.
        'per_quote', (select jsonb_object_agg(quote_no, n)
                        from (select quote_no, count(*) as n
                                from _q_rows group by quote_no
                               order by quote_no limit 200) x));
end$function$
;

revoke all on function public.ingest_invoices_via_webhook(p_api_key text, p_rows jsonb, p_sync_token text, p_final boolean) from public;
revoke all on function public.ingest_jobs_via_webhook(p_api_key text, p_rows jsonb) from public;
revoke all on function public.ingest_quotes_via_webhook(p_api_key text, p_rows jsonb) from public;
grant execute on function public.ingest_invoices_via_webhook(p_api_key text, p_rows jsonb, p_sync_token text, p_final boolean) to anon;
grant execute on function public.ingest_invoices_via_webhook(p_api_key text, p_rows jsonb, p_sync_token text, p_final boolean) to authenticated;
grant execute on function public.ingest_invoices_via_webhook(p_api_key text, p_rows jsonb, p_sync_token text, p_final boolean) to service_role;
grant execute on function public.ingest_jobs_via_webhook(p_api_key text, p_rows jsonb) to anon;
grant execute on function public.ingest_jobs_via_webhook(p_api_key text, p_rows jsonb) to authenticated;
grant execute on function public.ingest_jobs_via_webhook(p_api_key text, p_rows jsonb) to service_role;
grant execute on function public.ingest_quotes_via_webhook(p_api_key text, p_rows jsonb) to anon;
grant execute on function public.ingest_quotes_via_webhook(p_api_key text, p_rows jsonb) to authenticated;
grant execute on function public.ingest_quotes_via_webhook(p_api_key text, p_rows jsonb) to service_role;

commit;

notify pgrst, 'reload schema';

select 'rolled back: feeds back to the pre-188 bodies' as result;
