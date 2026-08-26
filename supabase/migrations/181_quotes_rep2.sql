--------------------------------------------------------------------------------
-- 181_quotes_rep2.sql — the quote feed carries WHO WROTE THE QUOTE.
--------------------------------------------------------------------------------
-- THE ASK (user, 2026-08-27): "we will be pulling another column called rep2,
-- which is the person who created the quote, we will use the spares reps in the
-- configure of spares to make it so that only the quotes with the spares reps
-- codes are shown in the quotes tab of spares".
--
-- The new payload, one line of it, exactly as the export sends it:
--
--   { "invnum": "4054", "name": "Gomacro", "invtitle": "",
--     "desc": "9707550-003-SA02 ULTRASONIC GUILLOTINE 900 DRIVE ROLLER (LAGGED)",
--     "qty": 2, "rate": 6058, "extend": 12116, "jobid": "",
--     "status": "*ACTIVE*", "date": "2026-08-21T00:00:00", "rep2": "DT" }
--
-- STORED UPPER-CASED, and that is not cosmetic. po.spares_reps stores its codes
-- through upper(trim(...)) (PO 039's add_spares_rep) and every comparison in
-- that module is upper-to-upper. A quote rep stored as sent would miss a rep
-- ticked as "dt" — silently, as an empty Quotes tab rather than an error.
--
-- LINE GRAIN, QUOTE FACT. rep2 repeats on every line of a quote, like the
-- debtor and the status. It is taken the same way they are: last-row-wins via
-- the existing `distinct on (quote_no) ... order by ord desc`, which is 173's
-- rule and is here so the stored header fields cannot disagree with each other.
--
-- WHY NOT A FOREIGN KEY to po.spares_reps: the feed must be able to land a rep
-- code nobody has classified yet — that is the normal state for a new starter,
-- and rejecting the row would lose the whole quote over a lookup table. The
-- Spares app filters on the join instead, so an unknown code simply doesn't
-- show there.
--
-- NULL IS NOT "NOT A SPARES REP". Every quote already in the table has
-- rep_code null until the feed re-sends it, and the user chose the STRICT
-- filter (2026-08-27): the Spares Quotes tab shows only quotes whose rep_code
-- is in po.spares_reps, so it reads EMPTY until the export cycles through. That
-- is expected on the day this goes in, and the app says so on the empty state
-- rather than looking broken.
--
-- The map row keeps working untouched: 'rep_column' defaults to 'rep2', so no
-- quotes_import_map entry is needed unless the export renames it later.
--
-- POWER AUTOMATE MUST SEND IT. Adding a key breaks the SENDER, never this
-- function — an unread key is simply ignored, so the flow can be updated before
-- or after this migration in either order. But a sender whose Parse JSON schema
-- no longer matches dies BEFORE its HTTP action, which looks like silence, not
-- like an error. Confirm quotes are still arriving after changing the flow.
--------------------------------------------------------------------------------

alter table public.quotes
    add column if not exists rep_code text;

comment on column public.quotes.rep_code is
    'Infusion rep2 — who created the quote — upper-cased to match po.spares_reps. '
    'Null on every quote written before 2026-08-27 and on any quote the export '
    'sends without a rep; null is NOT "not a spares rep", it is "not yet known".';

-- Filtering the Quotes tab is the whole point, and it is an equality/IN over
-- this column per org.
create index if not exists quotes_rep_code_idx
    on public.quotes (organisation_id, rep_code);


--------------------------------------------------------------------------------
-- The ingest, with rep2 threaded through. Everything else is 178 verbatim.
--------------------------------------------------------------------------------
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
    -- a quote, so the LAST occurrence wins — the same last-row-wins rule 173 and
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
            -- rep on every quote it touches and empty the Spares Quotes tab —
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
end$function$;

revoke all on function public.ingest_quotes_via_webhook(text, jsonb) from public;
grant execute on function public.ingest_quotes_via_webhook(text, jsonb) to anon, authenticated;

comment on function public.ingest_quotes_via_webhook(text, jsonb) is
    'Infusion quote feed. Upsert only — it NEVER prunes, because the export '
    'carries open/recent quotes and an absent quote has been accepted or '
    'declined, not deleted. Replaces the lines of every quote it mentions, so '
    'all lines of one quote must arrive in the same post. Since 181 it also '
    'stores rep2 as quotes.rep_code (upper-cased), which is what the Spares '
    'Quotes tab filters on.';

notify pgrst, 'reload schema';


--------------------------------------------------------------------------------
-- After applying — read-only checks
--------------------------------------------------------------------------------
--   -- Did the flow change land? Run this after the next push. All-null means
--   -- Power Automate is still sending the old shape; the ingest cannot tell
--   -- you that itself, because an unread key is not an error.
--   select count(*) as quotes,
--          count(*) filter (where rep_code is not null) as with_rep
--     from public.quotes;
--
--   -- Which rep codes is the export actually using, and is each one ticked as
--   -- a spares rep? Anything with is_spares = false is invisible in the Spares
--   -- Quotes tab until somebody ticks it in Configure.
--   select q.rep_code, count(*) as quotes,
--          exists (select 1 from po.spares_reps s
--                   where s.organisation_id = q.organisation_id
--                     and upper(s.rep) = q.rep_code) as is_spares
--     from public.quotes q
--    where q.rep_code is not null
--    group by q.rep_code, q.organisation_id
--    order by quotes desc;
