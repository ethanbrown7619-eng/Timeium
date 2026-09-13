-- 185_invoices_feed_stops_writing_job_type_and_status.sql
--
-- The invoices feed stops writing public.jobs.job_type and public.jobs.status,
-- and stops nulling start_date / due_date from a payload that never carried
-- them.
--
--
-- WHAT IT WAS DOING (user's diagnosis, 2026-09-14: "one of the webhooks is
-- looking for the jobtype and it is no longer being sent from there, so now
-- that webhook is receiving the job type is null, then every spares job is
-- being excluded from spares because nothing has a spares job type")
--
-- 174's jobs arm writes four job columns PLAINLY on conflict:
--
--     status     = excluded.status,
--     job_type   = excluded.job_type,
--     start_date = excluded.start_date,
--     due_date   = excluded.due_date,
--
-- No coalesce, no presence test. `r->>'jobtype'` on a payload without that key
-- is null, so the feed writes NULL straight over whatever the jobs feed just
-- set. The jobs sync populates the types; the next invoices sync erases them
-- for every job it touches; they run on different schedules. That is 180's
-- FAULT 1 exactly, from the other direction.
--
-- status is worse than null. `_canonical_job_status(null, map)` returns
-- 'ACTIVE' by design — it never rejects a row for a bad status — so a missing
-- `jobstatus` does not blank the status, it silently marks the job ACTIVE.
--
-- THE EVIDENCE. On 2026-09-14 the quotes Power Automate flow was found to be
-- posting the quotes export to THIS function (its response said
-- {"ok":true,"invoices":318,"pruned":0} — the invoices return shape). The quotes
-- export carries jobid but none of title / jobstatus / startdate / duedate /
-- jobtype. So every job named on a quote got job_type NULLed, status forced to
-- ACTIVE, and both dates cleared, ~318 rows at a time, every run.
--
-- Quotes attach to OPEN work. That is why the damage looked so strange:
--
--     2,537 SPARES-typed jobs, every one of them COMPLETED
--       206 of 230 ACTIVE jobs carrying no type at all
--
-- Completed jobs kept their type because real invoices do carry `jobtype`. Open
-- jobs lost theirs because quotes do not. It read exactly like Infusion typing
-- jobs only at completion, and it was not — the type was arriving and being
-- erased. po.spares_pipeline populates on job_type alone (ptl-purchase-orders
-- 053), so the Spares board could not see a single live job.
--
-- The flow is fixed. This closes the hole it came through, which the REAL
-- invoices export can still fall into the moment it drops a column.
--
--
-- WHAT CHANGES
--
-- 1. job_type LEAVES THIS FEED. Timeium 184 gave it back to the jobs webhook,
--    which is the right owner and could not have been chosen before: the
--    invoices feed only ever sees jobs that have been INVOICED, so an
--    uninvoiced job could never get a type from it. One column, one writer —
--    173's own rule, applied to the column 180 assigned the other way when the
--    jobs sender had no `type` key.
--
-- 2. status LEAVES THIS FEED, for the same reason and one more: this feed
--    cannot distinguish "Infusion says nothing" from "the column is missing",
--    and its answer to both is ACTIVE. 184 gave the jobs feed a presence test
--    so an absent status leaves the stored value alone. There is no version of
--    that available here that is better than not writing at all.
--
--    The INSERT arm drops the column entirely rather than defaulting it: a job
--    this feed sees FIRST still gets a status, from the column default
--    (030: not null default 'ACTIVE', CHECK-constrained), which is the same
--    value it would have written anyway.
--
-- 3. start_date / due_date GET 180's PRESENCE-PER-CALL TEST rather than
--    leaving. They stay because they are still worth having from an invoice for
--    a job the jobs feed has not delivered yet, but a payload that omits the
--    key no longer clears them. Present in ANY row means the field is in play
--    for this call and an empty value is a genuine clear (169's semantics,
--    which are deliberate — a date cleared in Infusion must clear here);
--    present in NO row means the sender is not sending it and the stored value
--    is left alone.
--
-- 4. description is UNCHANGED. It already used coalesce(excluded, existing), so
--    a missing `title` never cleared it. That is why job descriptions survived
--    a week of quote rows and only the other four columns were damaged.
--
-- customer_name remains absent from both arms, as 173 required: jobs sends the
-- CUSTOMER, invoices send the DEBTOR.
--
--
-- THE INVOICE ARM IS NOT TOUCHED. Invoice number, date, status, job_code,
-- quote_total and the prune are all exactly as 174 left them.
--
--
-- AFTER APPLYING, run one jobs sync and re-check:
--
--     select coalesce(job_type,'(untyped)') as job_type, count(*)
--       from public.jobs where status = 'ACTIVE' group by 1 order by 2 desc;
--
-- SPARES should now appear among the open jobs. If it still does not, the type
-- genuinely is not on the jobs export for open work and ptl-purchase-orders 096
-- (the Spares/Purchasing split by job type) must stay unapplied — that
-- measurement was taken while this feed was still erasing the column and cannot
-- be trusted until it is retaken.
--
-- Body is the LIVE 174 (read back with pg_get_functiondef, 2026-09-14 — it
-- matched the repo file exactly, no drift) with the four changes above. Same
-- signature, so existing grants survive. Safe to re-run.


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
    v_quote_col text;
    v_has_start boolean; v_has_due boolean;
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
    select coalesce(bool_or(jsonb_typeof(r) = 'object' and r ? v_start_col), false),
           coalesce(bool_or(jsonb_typeof(r) = 'object' and r ? v_due_col),   false)
      into v_has_start, v_has_due
      from jsonb_array_elements(
             case when jsonb_typeof(p_rows) = 'array' then p_rows else '[]'::jsonb end
           ) as t(r);

    ----------------------------------------------------------------- invoices --
    -- UNCHANGED from 174.
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
            'start_date', v_has_start, 'due_date', v_has_due)
    );
end$function$;
