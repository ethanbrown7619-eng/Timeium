-- 173_invoices_webhook.sql — the Infusion INVOICE feed.
--
-- A fourth Infusion webhook, alongside jobs / tasks / dept_codes. It exists for
-- the Spares module, which uses invoice status to drive a pipeline stage:
-- a PENDING invoice on an ACTIVE job means the job is waiting for dispatch
-- (user rule, 2026-08-12). See ptl-purchase-orders migration 043.
--
-- Payload columns (confirmed against the live export):
--
--   jobid  name  title  startdate  duedate  jobtype  jobstatus  invnum  invdate  invstatus
--
-- SEVEN of those ten are ALREADY ingested by the jobs webhook — the invoice
-- export is effectively the jobs export plus three invoice columns. Only
-- invnum / invdate / invstatus are new data, so only they get new storage.
--
-- The job columns are still written (user decision: "everything comes from the
-- same source, it's just a race"), with two deliberate guards:
--
--   1. `name` is DROPPED, not written. It is NOT the same field as the jobs
--      feed's `name`. Job 11342 is "Kind Snacks" in the jobs feed but
--      "Kind Snacks - TN" here, and only this export carries a debtor code —
--      the jobs feed sends the CUSTOMER, this sends the DEBTOR (billing entity
--      resolved to a site). Letting both write jobs.customer_name would make
--      that value flip between the two on every sync. jobs.customer_name stays
--      owned by ingest_jobs_via_webhook. The column is ignored whether or not
--      the export still sends it.
--   2. Only the LATEST invoice per job writes the job columns. A full-ledger
--      push sends one row per invoice, so a job with several invoices sends
--      several copies of its job fields; without this, whichever row happened
--      to land last would win. Ordering by invoice date makes it deterministic.
--
-- Why guard 2 matters beyond tidiness: public.jobs.status gates clock-in
-- (timesheet.js resolves a scanned job only when status = 'ACTIVE'), so a stale
-- status written here would stop someone clocking onto a job mid-week. It is
-- also unknown — and now deliberately moot — whether this export's job columns
-- are a LIVE JOIN (every row carries today's status) or a SNAPSHOT taken when
-- the invoice was raised (a 2010 invoice would push a long-closed job back to
-- its 2010 status, on every push). Latest-row-wins is correct under both.
--
-- PRUNE AT THE END, don't delete at the start. The feed is the whole ledger on
-- every push (~9,000 invoices back to 2010), so it must arrive in chunks. The
-- purchase-orders pusher handles that by having chunk 1 delete everything, and
-- its own comment admits a failed push leaves a partial snapshot. That is
-- acceptable for a report and NOT acceptable here, because these rows drive
-- stages: mid-sync, jobs would visibly fall out of "waiting for dispatch" and
-- climb back. Instead every row is stamped with a sync token and the FINAL
-- chunk deletes rows not carrying it — so the previous ledger stays whole and
-- correct until the new one has fully landed, and an aborted run prunes nothing.
--
-- Safe to re-run.


--------------------------------------------------------------------------------
-- 1. The webhook key + column map
--------------------------------------------------------------------------------
alter table public.org_secrets
    add column if not exists invoices_webhook_key text;

create unique index if not exists org_secrets_invoices_webhook_idx
    on public.org_secrets (invoices_webhook_key) where invoices_webhook_key is not null;

alter table public.organisations
    add column if not exists invoices_import_map jsonb;

comment on column public.organisations.invoices_import_map is
    'Optional column-name overrides for ingest_invoices_via_webhook. The defaults '
    'already match the live export, so this is only an escape hatch if the '
    'sender''s column names ever change.';

-- rotate_import_key gains the 'invoices' kind. Body carried forward from 141
-- with one extra branch; same signature, so grants survive.
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
    else raise exception 'unknown kind: %, expected jobs, tasks, dept_codes, or invoices', p_kind;
    end if;
    return v_key;
end$function$;


--------------------------------------------------------------------------------
-- 2. Invoice status normalisation
--------------------------------------------------------------------------------
-- The export TRUNCATES this column to six characters: 'Pendin', not 'Pending'.
-- Matching on a prefix rather than an exact string means the same code keeps
-- working if the width ever changes. The raw value is stored alongside so a
-- value we didn't anticipate is never silently lost.
create or replace function public._canonical_invoice_status(raw text)
returns text
language sql
immutable
as $$
  SELECT CASE
    WHEN raw IS NULL OR length(trim(raw)) = 0 THEN 'OTHER'
    WHEN upper(trim(raw)) LIKE 'POST%'   THEN 'POSTED'
    WHEN upper(trim(raw)) LIKE 'PEND%'   THEN 'PENDING'
    WHEN upper(trim(raw)) LIKE 'CANCEL%' THEN 'CANCELLED'
    WHEN upper(trim(raw)) LIKE 'CREDIT%' THEN 'CREDIT'
    ELSE 'OTHER'
  END;
$$;


--------------------------------------------------------------------------------
-- 3. The table
--------------------------------------------------------------------------------
create table if not exists public.invoices (
    organisation_id bigint      not null references public.organisations (id) on delete cascade,
    invoice_no      text        not null,
    invoice_date    date,
    status          text        not null default 'OTHER',
    raw_status      text,
    job_code        text,
    sync_token      text,
    last_synced_at  timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    primary key (organisation_id, invoice_no),
    constraint invoices_status_check
        check (status in ('POSTED', 'PENDING', 'CANCELLED', 'CREDIT', 'OTHER'))
);

comment on table public.invoices is
    'Infusion customer invoices, header only (no lines or amounts — the export '
    'carries none). Read by the Spares pipeline: a PENDING invoice on an ACTIVE '
    'job means waiting for dispatch.';
comment on column public.invoices.job_code is
    'The job this invoice bills, matching public.jobs.job_code. Deliberately NOT '
    'a foreign key: an invoice can arrive before the jobs feed has delivered its '
    'job, and an FK would reject the row outright. Nullable — the export has '
    'rows with no job at all.';
comment on column public.invoices.sync_token is
    'Stamped by the ingest run that last wrote this row. The final chunk of a '
    'push deletes rows NOT carrying the current token, so a partial push never '
    'shrinks the ledger.';

create index if not exists invoices_org_job_idx    on public.invoices (organisation_id, job_code);
create index if not exists invoices_org_status_idx on public.invoices (organisation_id, status);
create index if not exists invoices_org_date_idx   on public.invoices (organisation_id, invoice_date desc);

alter table public.invoices enable row level security;
grant select on public.invoices to authenticated;

-- Reads mirror public.jobs: any member of the org, plus admins. Writes are
-- exclusively through the SECURITY DEFINER ingest below, so no write policy is
-- granted — the same posture as po.spares_reps.
drop policy if exists "members read org invoices" on public.invoices;
create policy "members read org invoices"
    on public.invoices for select
    to authenticated
    using (
        public.is_admin_of(organisation_id)
        or exists (
            select 1 from public.users u
            where u.auth_user_id = auth.uid()
              and u.organisation_id = invoices.organisation_id
        )
        or exists (
            select 1 from public.admins a
            where a.user_id = auth.uid()
              and a.organisation_id = invoices.organisation_id
        )
    );


--------------------------------------------------------------------------------
-- 4. The webhook
--------------------------------------------------------------------------------
-- Anon-callable with the key, exactly like ingest_jobs_via_webhook, so Power
-- Automate can POST straight to PostgREST: no Worker, no service-role secret.
--
-- p_sync_token / p_final drive the prune described in the header. A push that
-- fits in one call can pass both (token + final:true) and get full replace
-- semantics; a chunked push passes the same token on every chunk and final:true
-- on the last one only. Omitting the token disables pruning entirely — rows are
-- upserted and nothing is ever removed, which is the safe default.
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
    v_inv_col     := coalesce(v_map->>'invoice_column',        'invnum');
    v_invdate_col := coalesce(v_map->>'invoice_date_column',   'invdate');
    v_invstat_col := coalesce(v_map->>'invoice_status_column', 'invstatus');
    v_stat_map    := coalesce(v_map->'status_map',             '{}'::jsonb);
    -- NOTE: there is deliberately no `name` mapping. See the header.

    ----------------------------------------------------------------- invoices --
    -- distinct on: a ledger push can legitimately repeat an invoice number
    -- across chunks; the later row in the payload wins.
    with src as (
        select
            trim(r->>v_inv_col)                          as invoice_no,
            public._parse_infusion_date(r->>v_invdate_col) as invoice_date,
            r->>v_invstat_col                            as raw_status,
            nullif(trim(coalesce(r->>v_job_col, '')), '') as job_code,
            rn
        from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality as t(r, rn)
    ),
    picked as (
        select distinct on (invoice_no) invoice_no, invoice_date, raw_status, job_code
        from src
        where length(coalesce(invoice_no, '')) > 0
        order by invoice_no, rn desc
    )
    insert into public.invoices (
        organisation_id, invoice_no, invoice_date, status, raw_status, job_code,
        sync_token, last_synced_at
    )
    select v_org, p.invoice_no, p.invoice_date,
           public._canonical_invoice_status(p.raw_status),
           nullif(trim(coalesce(p.raw_status, '')), ''),
           p.job_code, p_sync_token, now()
    from picked p
    on conflict (organisation_id, invoice_no) do update
        set invoice_date   = excluded.invoice_date,
            status         = excluded.status,
            raw_status     = excluded.raw_status,
            job_code       = excluded.job_code,
            sync_token     = excluded.sync_token,
            last_synced_at = now(),
            updated_at     = now();
    get diagnostics v_invoices = row_count;

    --------------------------------------------------------------------- jobs --
    -- Only the LATEST invoice per job writes the job columns (see header).
    -- customer_name is absent from both the insert and the update: this feed
    -- must never touch it.
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
