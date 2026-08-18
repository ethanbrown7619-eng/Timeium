-- 179_quotes_age_window.sql — the quote feed only keeps the last two years.
--
-- User, 2026-08-19: "lets start by only pulling quotes from the past 2 years".
--
-- WHY THE GUARD IS HERE AS WELL AS IN THE SENDER. The export sending less is the
-- real win — bytes not sent cannot time out, and the invoice feed has already
-- lost an email to a 3-second statement timeout on an oversized payload. This
-- end is the backstop: a flow rebuilt from scratch, or a filter someone drops
-- while debugging, must not silently refill the table with a decade of history.
-- Two independent limits, neither relying on the other being right.
--
-- THE WINDOW IS CONFIGURABLE, not a literal 24 buried in a function body:
--
--     update public.organisations
--        set quotes_import_map = coalesce(quotes_import_map, '{}'::jsonb)
--                              || '{"max_age_months": 36}'::jsonb;
--
-- 0 or a negative number turns the limit off entirely. The default when nothing
-- is set is 24 months, so applying this file alone implements the request.
--
-- DECIDED PER QUOTE, NOT PER ROW. The date arrives on every line of a quote, and
-- dropping individual rows would leave a quote holding some of its lines — a
-- silently wrong total, which is worse than an absent quote. Each quote's date
-- is taken the same way its header fields are (last occurrence in the payload
-- wins), and the whole quote is kept or skipped together.
--
-- A QUOTE WITH NO READABLE DATE IS KEPT. A null date is not evidence of age, and
-- dropping those would make an unparseable date column look like an empty feed.
--
-- THE SKIP COUNT COMES BACK IN THE RESPONSE (`skipped_too_old`). A limit that
-- silently swallows rows reads as "the export only had 40 quotes" — and someone
-- would eventually go looking for a fault in Power Automate that does not exist.
--
-- WHAT THIS DOES NOT DO: it does not delete quotes already loaded. Narrowing a
-- window is a decision about what to FETCH; deleting history on a config change
-- is a different act and should be typed out deliberately. The query for it is
-- in the footer.
--
-- Apply after 178. Safe to re-run.

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
    v_months integer; v_cutoff date;
    v_quotes integer := 0; v_lines integer := 0; v_skipped integer := 0;
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

    -- 179: the age window. A junk value in the map falls back to the default
    -- rather than raising — a typo in configuration must not stop the feed.
    begin
        v_months := coalesce((v_map->>'max_age_months')::integer, 24);
    exception when others then
        v_months := 24;
    end;
    v_cutoff := case when v_months > 0
                     then (current_date - make_interval(months => v_months))::date
                     else null end;

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

    -- 179: drop anything older than the window, WHOLE QUOTES at a time. The date
    -- used is the same one the header takes (last occurrence wins), so a quote
    -- is never judged by a date that is not the one stored against it.
    if v_cutoff is not null then
        with dated as (
            select distinct on (quote_no) quote_no, quote_date
              from _q_rows
             order by quote_no, ord desc)
        delete from _q_rows r
         using dated d
         where d.quote_no = r.quote_no
           and d.quote_date is not null
           and d.quote_date < v_cutoff;
        get diagnostics v_skipped = row_count;
    end if;

    if not exists (select 1 from _q_rows) then
        return jsonb_build_object('ok', true, 'quotes', 0, 'lines', 0,
                                  'skipped_too_old', v_skipped,
                                  'cutoff', v_cutoff,
                                  'note', 'nothing left to store after filtering');
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
        -- Reported, never silent: a limit that swallows rows quietly reads as a
        -- short export, and someone goes hunting for a fault that isn't there.
        'skipped_too_old', v_skipped,
        'cutoff', v_cutoff,
        -- Per-quote counts, so the sender can be checked against the one
        -- constraint this design places on it: all of a quote's lines must
        -- arrive in the same post.
        'per_quote', (select jsonb_object_agg(quote_no, n)
                        from (select quote_no, count(*) as n
                                from _q_rows group by quote_no
                               order by quote_no limit 200) x));
end$function$;

comment on function public.ingest_quotes_via_webhook(text, jsonb) is
    'Infusion quote feed. Upsert only — it NEVER prunes, because the export '
    'carries open/recent quotes and an absent quote has been accepted or '
    'declined, not deleted. Replaces the lines of every quote it mentions, so '
    'all lines of one quote must arrive in the same post. Ignores quotes dated '
    'more than quotes_import_map->>''max_age_months'' (default 24) before today, '
    'reporting the count as skipped_too_old.';

notify pgrst, 'reload schema';


--------------------------------------------------------------------------------
-- Verification / operations
--------------------------------------------------------------------------------
-- What the window is right now (null max_age_months means the 24-month default):
--
--   select quotes_import_map->>'max_age_months' as months from public.organisations;
--
-- Widen it to three years, or turn it off with 0:
--
--   update public.organisations
--      set quotes_import_map = coalesce(quotes_import_map, '{}'::jsonb)
--                            || '{"max_age_months": 36}'::jsonb;
--
-- Oldest and newest quote actually stored — the check that the window is doing
-- what you think, and that the sender's own filter agrees with it:
--
--   select min(quote_date), max(quote_date), count(*) from public.quotes;
--
-- REMOVING quotes already loaded that now fall outside the window. Deliberately
-- not automatic: narrowing what you FETCH and deleting what you HOLD are two
-- different decisions. Look before you delete —
--
--   select count(*), min(quote_date), max(quote_date)
--     from public.quotes
--    where quote_date < (current_date - interval '24 months');
--
--   -- then, if that is what you meant (lines go first: no cascade between them)
--   delete from public.quote_lines l
--    using public.quotes q
--    where q.organisation_id = l.organisation_id
--      and q.quote_no = l.quote_no
--      and q.quote_date < (current_date - interval '24 months');
--   delete from public.quotes
--    where quote_date < (current_date - interval '24 months');
