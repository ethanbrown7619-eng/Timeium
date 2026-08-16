-- 174_invoice_quote_total.sql
--
-- The invoices export gained a column. It now sends eleven, not ten:
--
--   jobid name title startdate duedate jobtype jobstatus quotetotal invnum invdate invstatus
--                                                        ^^^^^^^^^^ new
--
-- `quotetotal` is the first AMOUNT this feed has ever carried. Everything up to
-- now was header text and dates — see 173's header, which records that the
-- export has no rate/qty/extend and that the sell-side gap therefore stayed
-- open. This narrows that gap: it is a SELL-side figure, the first the ERP has
-- held. Everything in po.* is supplier cost.
--
-- IT IS AN INVOICE COLUMN (user decision, 2026-08-17). Note this is NOT what
-- the column ordering suggests — quotetotal sits inside the job block, ahead of
-- invnum/invdate/invstatus, so position alone would put it on public.jobs
-- alongside the 169 columns. It does not go there. It is stored per invoice, on
-- the invoice grain, and the job-column arm of this webhook is untouched.
--
-- Consequence of the grain, worth being explicit about: `picked` keeps ONE row
-- per invoice_no (last occurrence in the payload wins), so if a ledger push
-- repeats an invoice number with differing quote totals, the later row's figure
-- is the one stored. That is the same rule already governing invoice_date and
-- status, so quote_total cannot disagree with the rest of its own row.
--
-- Note this migration is NOT what unblocks a stalled feed. `r->>'quotetotal'`
-- on a payload that lacks the key returns null, and an unknown key in a payload
-- is simply never read — the RPC has always been indifferent to extra columns.
-- A shape change breaks the SENDER (a Parse JSON schema, a column mapping),
-- never this end. This migration is about capturing the new value, not repair.
--
-- Safe to re-run.


--------------------------------------------------------------------------------
-- 1. The column
--------------------------------------------------------------------------------
alter table public.invoices
    add column if not exists quote_total numeric(14,2);

comment on column public.invoices.quote_total is
    'Quoted total carried on the invoice row, from the webhook''s "quotetotal" '
    'column. Null when Infusion sent nothing or sent something unparseable. '
    'SELL-side money (what the customer was quoted) — unlike po.*, which is '
    'supplier cost throughout. Not an invoiced amount: the export still carries '
    'no rate/qty/extend, so this is what was quoted, not what was billed.';


--------------------------------------------------------------------------------
-- 2. The money parser
--------------------------------------------------------------------------------
-- Same defensive posture as _parse_infusion_date (169): a value this function
-- cannot read costs that one field, never the whole payload. The upsert below
-- is a single statement, so an uncaught cast error would abort every row in the
-- push — which is exactly the failure the date parser was hardened against.
--
-- Accepted, because there is no telling which of these the export will emit
-- once a spreadsheet or Power Automate has been through it:
--
--   1234.56      a real numeric column, serialised plainly
--   1,234.56     thousands separators from a text/display column
--   $1,234.56    currency symbol
--   (1,234.56)   accounting negative — a credit note
--   ''           empty, nothing quoted
--   '-', 'N/A'   junk that is not a number; treated as absent, not an error
--
-- NOT handled: European 1.234,56. Infusion is NZ-localised and emits the
-- period as the decimal mark. If that ever changes this function must change
-- with it, because the two formats are genuinely ambiguous (1.234 is either
-- one thousand two hundred and thirty four, or one and a bit) and guessing
-- would silently misprice a thousand invoices.
create or replace function public._parse_infusion_money(raw text)
returns numeric
language plpgsql
immutable
as $$
declare
    t     text := trim(coalesce(raw, ''));
    v_neg boolean := false;
    v     numeric;
begin
    if length(t) = 0 then
        return null;
    end if;

    -- Accounting negative: (1,234.56) is -1234.56. Detected before the strip
    -- below, which would otherwise throw the parentheses away and turn a credit
    -- into a charge.
    if t ~ '^\(.*\)$' then
        v_neg := true;
        t := substring(t from 2 for length(t) - 2);
    end if;

    -- Drop currency symbols, separators and spaces. The '-' sits last in the
    -- bracket expression so it reads as a literal hyphen, not a range.
    t := regexp_replace(t, '[^0-9.-]', '', 'g');
    if length(t) = 0 then
        return null;
    end if;

    begin
        v := t::numeric;
    exception when others then
        return null;   -- unparseable: absent, not fatal
    end;

    if v_neg then
        v := -v;
    end if;
    return v;
end$$;

comment on function public._parse_infusion_money(text) is
    'Tolerant numeric parser for Infusion exports. Returns null rather than '
    'raising, so one junk value cannot abort a whole webhook payload.';


--------------------------------------------------------------------------------
-- 3. The webhook
--------------------------------------------------------------------------------
-- Body carried forward verbatim from 173; the only changes are the quotetotal
-- column mapping and the three places quote_total is written, all inside the
-- INVOICES arm. The jobs arm is byte-for-byte 173.
-- Same signature, so the existing grants survive CREATE OR REPLACE.
--
-- The new column name defaults to exactly what the sender calls it, so no
-- organisations.invoices_import_map update is needed to switch this on. The
-- map key stays available as the escape hatch if the casing ever differs.
--
-- quote_total is written PLAINLY, not coalesce(excluded, existing) — matching
-- how 173 treats invoice_date/status and for the same reason: these columns
-- mirror the source system. If a quote is revised down in Infusion it must
-- follow here; coalesce would pin the old figure forever, and a stale price is
-- worse than no price.
create or replace function public.ingest_invoices_via_webhook(
    p_api_key    text,
    p_rows       jsonb   default '[]'::jsonb,
    p_sync_token text    default null,
    p_final      boolean default false
)
returns jsonb language plpgsql security definer set search_path = public as $function$
declare
    v_org bigint; v_map jsonb;
    v_job_col text; v_title_col text; v_jstat_col text; v_start_col text;
    v_due_col text; v_type_col text; v_stat_map jsonb;
    v_inv_col text; v_invdate_col text; v_invstat_col text;
    v_quote_col text;
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
    v_jstat_col   := coalesce(v_map->>'job_status_column',     'jobstatus');
    v_start_col   := coalesce(v_map->>'start_date_column',     'startdate');
    v_due_col     := coalesce(v_map->>'due_date_column',       'duedate');
    v_type_col    := coalesce(v_map->>'job_type_column',       'jobtype');
    v_quote_col   := coalesce(v_map->>'quote_total_column',    'quotetotal');
    v_inv_col     := coalesce(v_map->>'invoice_column',        'invnum');
    v_invdate_col := coalesce(v_map->>'invoice_date_column',   'invdate');
    v_invstat_col := coalesce(v_map->>'invoice_status_column', 'invstatus');
    v_stat_map    := coalesce(v_map->'status_map',             '{}'::jsonb);
    -- NOTE: there is deliberately no `name` mapping. See 173's header.

    ----------------------------------------------------------------- invoices --
    -- distinct on: a ledger push can legitimately repeat an invoice number
    -- across chunks; the later row in the payload wins. quote_total rides that
    -- same rule, so it always agrees with the date/status stored beside it.
    with src as (
        select
            trim(r->>v_inv_col)                          as invoice_no,
            public._parse_infusion_date(r->>v_invdate_col) as invoice_date,
            r->>v_invstat_col                            as raw_status,
            nullif(trim(coalesce(r->>v_job_col, '')), '') as job_code,
            public._parse_infusion_money(r->>v_quote_col) as quote_total,
            rn
        from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality as t(r, rn)
    ),
    picked as (
        select distinct on (invoice_no)
               invoice_no, invoice_date, raw_status, job_code, quote_total
        from src
        where length(coalesce(invoice_no, '')) > 0
        order by invoice_no, rn desc
    )
    insert into public.invoices (
        organisation_id, invoice_no, invoice_date, status, raw_status, job_code,
        quote_total, sync_token, last_synced_at
    )
    select v_org, p.invoice_no, p.invoice_date,
           public._canonical_invoice_status(p.raw_status),
           nullif(trim(coalesce(p.raw_status, '')), ''),
           p.job_code, p.quote_total, p_sync_token, now()
    from picked p
    on conflict (organisation_id, invoice_no) do update
        set invoice_date   = excluded.invoice_date,
            status         = excluded.status,
            raw_status     = excluded.raw_status,
            job_code       = excluded.job_code,
            quote_total    = excluded.quote_total,
            sync_token     = excluded.sync_token,
            last_synced_at = now(),
            updated_at     = now();
    get diagnostics v_invoices = row_count;

    --------------------------------------------------------------------- jobs --
    -- UNCHANGED from 173. quotetotal is stored on the invoice, not here.
    -- Only the LATEST invoice per job writes the job columns (see 173's header).
    -- customer_name is absent from both the insert and the update: this feed
    -- must never touch it — jobs sends the CUSTOMER, invoices send the DEBTOR.
    with src as (
        select
            nullif(trim(coalesce(r->>v_job_col, '')), '')  as job_code,
            nullif(trim(coalesce(r->>v_title_col, '')), '') as title,
            r->>v_jstat_col                                 as job_status,
            public._parse_infusion_date(r->>v_start_col)    as start_date,
            public._parse_infusion_date(r->>v_due_col)      as due_date,
            nullif(upper(trim(coalesce(r->>v_type_col, ''))), '') as job_type,
            public._parse_infusion_date(r->>v_invdate_col)  as invoice_date,
            rn
        from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality as t(r, rn)
    ),
    latest as (
        select distinct on (job_code) job_code, title, job_status, start_date, due_date, job_type
        from src
        where length(coalesce(job_code, '')) > 0
        order by job_code, invoice_date desc nulls last, rn desc
    )
    insert into public.jobs (
        organisation_id, job_code, description, status, job_type,
        start_date, due_date, source, last_synced_at
    )
    select v_org, l.job_code, l.title,
           public._canonical_job_status(l.job_status, v_stat_map),
           l.job_type, l.start_date, l.due_date, 'webhook', now()
    from latest l
    on conflict (organisation_id, job_code) do update
        set description    = coalesce(excluded.description, jobs.description),
            status         = excluded.status,
            job_type       = excluded.job_type,
            start_date     = excluded.start_date,
            due_date       = excluded.due_date,
            source         = 'webhook',
            last_synced_at = now(),
            updated_at     = now();
    get diagnostics v_jobs = row_count;

    -------------------------------------------------------------------- prune --
    -- Only on the final chunk, and only when a token was supplied: without one
    -- every row would look stale and the whole ledger would be deleted.
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
        'finalised', (p_final and p_sync_token is not null)
    );
end$function$;

grant execute on function public.ingest_invoices_via_webhook(text, jsonb, text, boolean) to anon, authenticated;

notify pgrst, 'reload schema';
