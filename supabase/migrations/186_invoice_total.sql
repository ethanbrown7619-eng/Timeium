-- 186_invoice_total.sql
--
-- The invoices export now carries the INVOICED amount. Store it.
--
-- New shape, seen 2026-09-17 (one row per invoice, as before):
--
--     jobid name title startdate duedate invnum invdate invtotal invstatus
--
-- Against 174's shape, ONE column left (quotetotal) and ONE arrived (invtotal).
-- Everything else is the same set of keys. Three cosmetic differences that need
-- no code: dates are ISO (2025-12-12) rather than M/D/YYYY, invstatus arrives
-- whole ("Posted", not "Pendin"), and invtotal is a JSON number rather than a
-- string — _parse_infusion_date already takes ISO (170), _canonical_invoice_
-- status already upper-cases and prefix-matches, and r->>'invtotal' renders a
-- JSON number as text for _parse_infusion_money exactly as it did a string.
--
--
-- WHAT CHANGES
--
-- 1. public.invoices.invoice_total numeric(14,2) — what was BILLED on that
--    invoice. The first billed figure the ERP has held: quote_total (174) was
--    what was quoted, and the quotes feed (178) is line-level quoted; po.* is
--    supplier cost throughout. Read from `invtotal` (invoices_import_map
--    `invoice_total_column` overrides it, like every other key here).
--
-- 2. quote_total STAYS, and STOPS BEING WRITTEN when the payload does not
--    carry `quotetotal`. Under 174/185 it is written PLAINLY on conflict, so
--    the first push of the new shape would have set it null on all ~100 rows —
--    180's FAULT 1 again, with money this time. Both money columns now get the
--    presence-per-call test the dates got in 185: present in ANY row and the
--    column is in play (an empty value is a genuine clear); present in NO row
--    and the stored value is left alone. The Spares board still falls back to
--    invoices.quote_total for jobs older than the quotes window
--    (PTL-spares pipeline.js quoteOf), so the stored figures keep earning
--    their keep.
--
-- 3. The response's columns_in_payload gains quote_total and invoice_total,
--    so the flow's own run history shows which money column it is sending.
--
-- THE JOBS ARM IS NOT TOUCHED. Note for the reader of the new payload: it sends
-- `"duedate": null` explicitly, which under 185's rule is "present" — so a
-- job whose due date is blank in Infusion will be cleared here. That is the
-- rule working (169: a date cleared in Infusion must clear here); the jobs
-- feed's lean payload (180) sends no dates at all, so this feed is the only
-- date writer for invoiced jobs now.
--
-- Body is the LIVE 185 with the changes above. Same signature, so existing
-- grants survive. Safe to re-run.

alter table public.invoices
    add column if not exists invoice_total numeric(14,2);

comment on column public.invoices.invoice_total is
    'Invoiced total on the invoice row, from the webhook''s "invtotal" column '
    '(first seen 2026-09-17). Null when Infusion sent nothing or sent something '
    'unparseable, and null on every row until the feed has run since 186 was '
    'applied. What was BILLED — unlike quote_total (what was quoted) and unlike '
    'po.* (supplier cost throughout).';

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
    -- belong to ingest_jobs_via_webhook (184) — see the header. The mappings go
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
    -- 185: status and job_type are GONE from both the insert and the update —
    -- they belong to the jobs feed (184). start_date and due_date survive but
    -- only write when the payload actually carried the key.
    --
    -- Only the LATEST invoice per job writes the job columns (see 173's header).
    -- customer_name is absent from both the insert and the update: this feed
    -- must never touch it — jobs sends the CUSTOMER, invoices send the DEBTOR.
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
end$function$;

-- VERIFICATION (after the feed has run once):
--   select count(*) filter (where invoice_total is null) as no_total,
--          count(*) filter (where quote_total   is null) as no_quote,
--          count(*) from public.invoices;
--   no_total should be ~0; no_quote should be UNCHANGED from before the run
--   (the new shape does not carry quotetotal, so nothing may have touched it).
--   The flow's response should read
--   "columns_in_payload": {"quote_total": false, "invoice_total": true, ...}.
