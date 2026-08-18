-- 178_quotes_webhook.sql — the Infusion QUOTE feed.
--
-- A fifth Infusion webhook, alongside jobs / tasks / dept_codes / invoices.
-- Like the invoice feed it lives here rather than in a module repo because the
-- key column, rotate_import_key and the whole webhook pattern are Timeium-owned;
-- the CONSUMER is the Spares module (see 173's header, same arrangement).
--
-- Payload columns (as supplied, 2026-08-19):
--
--   invnum  name  invtitle  desc  qty  rate  extend  jobid  status  date
--
-- THIS FEED HAS A DIFFERENT GRAIN TO EVERY FEED BEFORE IT. jobs and invoices are
-- one row per thing; this is one row per quote LINE, with the quote's own fields
-- (invnum, name, invtitle, jobid, status, date) repeated on each. So it lands in
-- two tables: public.quotes, one row per quote, and public.quote_lines, one row
-- per line.
--
-- IT IS ALSO THE FIRST SELL-SIDE DETAIL THE ERP HAS EVER HELD. Everything in
-- po.* is supplier cost; 174 added a single quotetotal per invoice. desc / qty /
-- rate / extend is the actual quoted line. Worth stating because it changes what
-- the database can answer — "what did we quote for this" was previously
-- unanswerable without opening Infusion.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
--   1. It never writes public.jobs. Not the customer, not the status, not the
--      dates. 173 records why: that export's `name` is the DEBTOR (billing
--      entity, site-resolved) while the jobs feed's `name` is the CUSTOMER —
--      job 11342 is "Kind Snacks" in one and "Kind Snacks - TN" in the other.
--      Two feeds writing one column makes the value flip on every sync. This
--      feed's `name` is stored as quotes.debtor_name and stays there. If it
--      later proves to be the customer after all, that is a deliberate decision
--      with evidence, not a default.
--
--   2. It does not prune. The export sends only open/recent quotes (user,
--      2026-08-19), so "absent from the payload" means "not currently open" —
--      NOT "deleted". Pruning on absence would erase every quote the moment it
--      was accepted, which is precisely the history worth keeping. Rows are
--      upserted and nothing is ever removed. `last_seen_at` records when a quote
--      was last in an export, which is the honest way to show staleness without
--      inventing a death rule. If the feed ever becomes a full ledger, 173's
--      sync-token prune is the pattern to copy — do not bolt one on before then.
--
--   3. It does not canonicalise `status` into a fixed set. 173 could, because
--      its four invoice states were known and confirmed. The quote vocabulary
--      here has NOT been seen yet, and a CHECK constraint guessed wrong rejects
--      real rows — the one failure mode a feed must not have. Status is stored
--      upper-cased and trimmed, with the raw value beside it, and a canonical
--      mapping can be added once the live values are known. Until then the app
--      shows what Infusion said.
--
-- ONE CONSTRAINT ON THE SENDER: all lines for a given quote must arrive in the
-- SAME post. Each call replaces the lines of every quote it mentions, so a quote
-- split across two chunks would keep only the second chunk's lines. The response
-- returns a per-quote line count so this is checkable rather than silent. A
-- payload of a few hundred open quotes fits comfortably in one call; this is a
-- note for whoever later decides to chunk it.
--
-- Safe to re-run.


--------------------------------------------------------------------------------
-- 1. The webhook key + column map
--------------------------------------------------------------------------------
alter table public.org_secrets
    add column if not exists quotes_webhook_key text;

create unique index if not exists org_secrets_quotes_webhook_idx
    on public.org_secrets (quotes_webhook_key) where quotes_webhook_key is not null;

alter table public.organisations
    add column if not exists quotes_import_map jsonb;

comment on column public.organisations.quotes_import_map is
    'Optional column-name overrides for ingest_quotes_via_webhook. The defaults '
    'already match the export as supplied, so this is only an escape hatch if the '
    'sender''s column names change.';

-- rotate_import_key gains the 'quotes' kind. Body carried forward from 173 (NOT
-- from 141 — 173 is the live version and already added the invoices branch) with
-- one extra branch; same signature, so grants survive.
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
    elsif p_kind = 'quotes' then update public.org_secrets set quotes_webhook_key = v_key, updated_at = now() where organisation_id = v_org;
    else raise exception 'unknown kind: %, expected jobs, tasks, dept_codes, invoices, or quotes', p_kind;
    end if;
    return v_key;
end$function$;


--------------------------------------------------------------------------------
-- 2. Reading Infusion's numbers
--------------------------------------------------------------------------------
-- qty / rate / extend are the first numeric columns any of these feeds has had,
-- and how they serialise depends on the export's own formatting: "1,234.56",
-- "$1,234.56" and "(123.45)" for a negative are all plausible from a
-- report-style column, while a real numeric column sends "1234.56".
--
-- Every one of those is accepted. Anything genuinely unreadable becomes NULL
-- rather than raising: one bad cell must cost that cell, not the whole payload —
-- the same rule 169's date parser follows, and for the same reason (the insert
-- is a single statement, so an exception aborts every row in the push).
create or replace function public._parse_infusion_number(raw text)
returns numeric
language plpgsql
immutable
as $function$
declare
    v_txt text;
    v_neg boolean := false;
    v_num numeric;
begin
    v_txt := trim(coalesce(raw, ''));
    if v_txt = '' then return null; end if;

    -- The sign is read BEFORE stripping and re-applied after, because both ways
    -- of writing it are punctuation: "(123.45)" is an accounting negative and
    -- "-123.45" a plain one, and neither survives the strip below.
    v_neg := v_txt like '(%)' or v_txt like '-%';

    -- Keep digits and the decimal point only. Drops currency symbols, thousands
    -- separators, stray spaces, the brackets and the minus.
    v_txt := regexp_replace(v_txt, '[^0-9.]', '', 'g');
    if v_txt = '' or v_txt = '.' then return null; end if;

    begin
        v_num := v_txt::numeric;
    exception when others then
        return null;
    end;

    if v_neg and v_num > 0 then v_num := -v_num; end if;
    return v_num;
end$function$;

comment on function public._parse_infusion_number(text) is
    'Text to numeric for the Infusion feeds. Tolerates currency symbols, thousands '
    'separators and (bracketed) negatives; returns NULL rather than raising, so a '
    'single unreadable cell costs that cell and not the whole payload.';


--------------------------------------------------------------------------------
-- 3. The tables
--------------------------------------------------------------------------------
create table if not exists public.quotes (
    organisation_id bigint      not null references public.organisations (id) on delete cascade,
    quote_no        text        not null,
    title           text,
    debtor_name     text,
    job_code        text,
    status          text,
    raw_status      text,
    quote_date      date,
    -- Both derived from the lines in the same push, so a quote's totals can
    -- never disagree with the lines shown underneath it.
    line_count      integer     not null default 0,
    total_value     numeric(14,2),
    first_seen_at   timestamptz not null default now(),
    last_seen_at    timestamptz not null default now(),
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    primary key (organisation_id, quote_no)
);

comment on table public.quotes is
    'Infusion quotes, one row per quote. Fed by ingest_quotes_via_webhook; the '
    'export carries only open/recent quotes, so a row that stops arriving has '
    'stopped being open — it is NOT deleted. See last_seen_at.';
comment on column public.quotes.job_code is
    'The job this quote is against, matching public.jobs.job_code. Deliberately '
    'NOT a foreign key: a quote normally EXISTS BEFORE ITS JOB DOES — that is the '
    'whole shape of the spares process (enquiry, quote, then job) — so an FK '
    'would reject exactly the rows that matter most. Often null.';
comment on column public.quotes.debtor_name is
    'The export''s `name`. Stored here and NOT written to jobs.customer_name: on '
    'the invoice feed the same column proved to be the DEBTOR, not the customer '
    '(job 11342 is "Kind Snacks" to the jobs feed and "Kind Snacks - TN" here), '
    'and two feeds writing one column makes it flip on every sync.';
comment on column public.quotes.status is
    'Upper-cased, trimmed. NOT mapped to a fixed set and NOT constrained — the '
    'live vocabulary has not been seen yet, and a CHECK guessed wrong would '
    'reject real rows. Add a _canonical_quote_status once the values are known.';
comment on column public.quotes.last_seen_at is
    'When this quote was last present in an export. The feed is incremental, so '
    'this is the only available signal that a quote has moved on; nothing infers '
    'a status from it.';

create index if not exists quotes_org_job_idx    on public.quotes (organisation_id, job_code);
create index if not exists quotes_org_status_idx on public.quotes (organisation_id, status);
create index if not exists quotes_org_date_idx   on public.quotes (organisation_id, quote_date desc);


create table if not exists public.quote_lines (
    id              bigserial   primary key,
    organisation_id bigint      not null references public.organisations (id) on delete cascade,
    quote_no        text        not null,
    -- Position within the quote, assigned from the payload's own row order.
    -- The export carries NO line identifier, so this is the only line identity
    -- available — which is also why a push replaces a quote's lines wholesale
    -- rather than trying to match them one by one.
    line_no         integer     not null,
    description     text,
    qty             numeric(14,3),
    rate            numeric(14,4),
    extended        numeric(14,2),
    created_at      timestamptz not null default now(),
    unique (organisation_id, quote_no, line_no)
);

comment on table public.quote_lines is
    'One row per quoted line. The first sell-side line detail in this database — '
    'everything in po.* is supplier cost. Replaced wholesale whenever its quote '
    'appears in a push, so all of a quote''s lines must arrive in the same post.';
comment on column public.quote_lines.rate is
    '4dp, unlike the 2dp money columns: a unit rate on a small part is routinely '
    'quoted to fractions of a cent, and rounding it here would make qty * rate '
    'stop matching the extended figure Infusion sent.';

create index if not exists quote_lines_quote_idx
    on public.quote_lines (organisation_id, quote_no, line_no);


--------------------------------------------------------------------------------
-- 4. Reading them
--------------------------------------------------------------------------------
-- Mirrors public.invoices exactly: members of the org read, and writes happen
-- only through the SECURITY DEFINER ingest below, so no write policy exists.
alter table public.quotes      enable row level security;
alter table public.quote_lines enable row level security;

grant select on public.quotes      to authenticated;
grant select on public.quote_lines to authenticated;

drop policy if exists "members read org quotes" on public.quotes;
create policy "members read org quotes"
    on public.quotes for select
    to authenticated
    using (
        public.is_admin_of(organisation_id)
        or exists (
            select 1 from public.users u
             where u.auth_user_id = auth.uid()
               and u.organisation_id = public.quotes.organisation_id));

drop policy if exists "members read org quote lines" on public.quote_lines;
create policy "members read org quote lines"
    on public.quote_lines for select
    to authenticated
    using (
        public.is_admin_of(organisation_id)
        or exists (
            select 1 from public.users u
             where u.auth_user_id = auth.uid()
               and u.organisation_id = public.quote_lines.organisation_id));


--------------------------------------------------------------------------------
-- 5. The ingest
--------------------------------------------------------------------------------
-- Anon-callable with the key, exactly like the other four feeds, so Power
-- Automate can POST straight to PostgREST: no Worker, no service-role secret.
-- The key travels in the BODY as p_api_key (a header proved unreliable through
-- Power Automate — see po.ingest_ticket_email).
create or replace function public.ingest_quotes_via_webhook(
    p_api_key text,
    p_rows    jsonb default '[]'::jsonb
)
returns jsonb language plpgsql security definer set search_path = public as $function$
declare
    v_org bigint; v_map jsonb;
    v_no_col text; v_name_col text; v_title_col text; v_desc_col text;
    v_qty_col text; v_rate_col text; v_ext_col text; v_job_col text;
    v_stat_col text; v_date_col text;
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
    -- a quote, so the LAST occurrence wins — the same last-row-wins rule 173 and
    -- 174 use, chosen there so the stored fields cannot disagree with each other.
    -- Totals come from the lines in this same payload, never from a header
    -- column, so what the app shows always adds up to what it lists.
    insert into public.quotes as q (
        organisation_id, quote_no, title, debtor_name, job_code,
        status, raw_status, quote_date, line_count, total_value,
        first_seen_at, last_seen_at)
    select v_org,
           h.quote_no, h.title, h.debtor_name, h.job_code,
           h.status, h.raw_status, h.quote_date,
           agg.n, agg.total,
           now(), now()
      from (select distinct on (quote_no)
                   quote_no, title, debtor_name, job_code, status, raw_status, quote_date
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
        -- Per-quote counts, so the sender can be checked against the one
        -- constraint this design places on it: all of a quote's lines must
        -- arrive in the same post.
        'per_quote', (select jsonb_object_agg(quote_no, n)
                        from (select quote_no, count(*) as n
                                from _q_rows group by quote_no
                               order by quote_no limit 200) x));
end$function$;

revoke all on function public.ingest_quotes_via_webhook(text, jsonb) from public;
grant execute on function public.ingest_quotes_via_webhook(text, jsonb) to anon, authenticated;

comment on function public.ingest_quotes_via_webhook(text, jsonb) is
    'Infusion quote feed. Upsert only — it NEVER prunes, because the export '
    'carries open/recent quotes and an absent quote has been accepted or '
    'declined, not deleted. Replaces the lines of every quote it mentions, so '
    'all lines of one quote must arrive in the same post.';

notify pgrst, 'reload schema';


--------------------------------------------------------------------------------
-- Turning it on
--------------------------------------------------------------------------------
-- 1. Mint the key (as an admin, in the SQL editor or from the app):
--
--      select public.rotate_import_key('quotes');
--
-- 2. Point a Power Automate flow at:
--
--      POST https://<project>.supabase.co/rest/v1/rpc/ingest_quotes_via_webhook
--      apikey / Authorization: the ANON key, as the other feeds do
--      body: { "p_api_key": "<the key from step 1>", "p_rows": [ … ] }
--
--    where p_rows is the export as an array of objects keyed by the column
--    names: invnum, name, invtitle, desc, qty, rate, extend, jobid, status, date.
--
-- 3. The response says what landed: {"ok":true,"quotes":N,"lines":M,"per_quote":{…}}.
--
--
-- Verification, read-only:
--
--   select count(*) as quotes, sum(line_count) as lines, sum(total_value) as value
--     from public.quotes;
--
--   -- what statuses does Infusion actually send? THIS is the question to answer
--   -- before anyone writes a canonical mapping or a stage rule on top of it:
--   select status, count(*) from public.quotes group by 1 order by 2 desc;
--
--   -- do the numbers read correctly, or did the parser meet a format it did not
--   -- expect? A pile of nulls here means the export is sending something the
--   -- parser drops, not that the quotes have no values:
--   select count(*) filter (where qty      is null) as no_qty,
--          count(*) filter (where rate     is null) as no_rate,
--          count(*) filter (where extended is null) as no_extended,
--          count(*) as lines
--     from public.quote_lines;
--
--   -- does qty * rate agree with what Infusion called the extension? A tolerance
--   -- of a cent absorbs its own rounding; anything bigger means we are reading
--   -- one of the three columns wrongly:
--   select count(*) from public.quote_lines
--    where qty is not null and rate is not null and extended is not null
--      and abs(qty * rate - extended) > 0.01;
--
--   -- how many quotes name a job that does not exist here? Expect some: a quote
--   -- normally precedes its job.
--   select count(*) from public.quotes q
--    where q.job_code is not null
--      and not exists (select 1 from public.jobs j
--                       where j.organisation_id = q.organisation_id
--                         and j.job_code = q.job_code);
