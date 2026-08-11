-- 169_jobs_customer_dates_type.sql
--
-- Pull four more fields off the existing jobs webhook: customer, start date,
-- due date and job type.
--
-- The timesheet webhook already queries the whole jobs list from Infusion, so
-- these ride along on a request we're making anyway rather than needing a
-- second feed. Nothing in the timesheet uses them — they're here for the
-- Spares module, which needs to know a job's customer and dates without
-- querying Infusion itself.
--
-- Incoming payload (confirmed against the live sender):
--
--   jobid   name              title            startdate  duedate    type    status
--   11342   Kind Snacks       10917 - FRIST…   4/21/2026  1/0/1900   SPARES  *ACTIVE*
--   11355   Gollek Inter…     Additions to …   5/4/2026   8/28/2026  SPARES  INVOICED
--
-- jobid/title/status are already mapped. This adds name → customer_name,
-- startdate → start_date, duedate → due_date, type → job_type.
--
-- Safe to re-run.


--------------------------------------------------------------------------------
-- 1. The date parser
--------------------------------------------------------------------------------
-- Infusion writes 1/0/1900 for "no date" — see duedate on nearly every row
-- above. Two separate traps here, and only one of them is the obvious one:
--
--   * to_date() does NOT reject 1/0/1900. Day zero rolls back a day and it
--     returns 1900-01-01, so the sentinel arrives looking like a real date.
--     It has to be caught by value afterwards. The <1901 guard is deliberately
--     wider than the one literal so the whole family of zero-ish sentinels
--     (0/0/0000, and the ISO 1900-01-01T00:00:00 the same empty date becomes
--     once Power Automate serialises it) lands as null too.
--   * Genuinely malformed input DOES raise. Unhandled, one bad row aborts the
--     entire webhook payload, because the upsert below is a single statement.
--     Hence the exception block: a junk date costs that one field, not the
--     whole sync.
--
-- TWO input formats are accepted, because the sender's format depends on how
-- Power Automate happens to serialise the column:
--
--   * M/D/YYYY  — what a text/display column sends, e.g. 4/21/2026. Confirmed
--     M/D not D/M by the data itself: 8/28/2026 has day > 12. FM strips the
--     leading-zero requirement so 04/21/2026 works too.
--   * ISO 8601  — what a real date/datetime column sends once Power Automate
--     serialises it, e.g. 2026-04-21T00:00:00. This is NOT a hypothetical: it
--     is the default for a SQL date column, and the M/D/YYYY parser rejects it
--     outright, so every date would have silently become null.
--
-- Anything else is null rather than an error. A date we can't read costs that
-- one field; raising would cost the whole payload.
create or replace function public._parse_infusion_date(raw text)
returns date
language plpgsql
immutable
as $$
declare
    v date;
    t text := trim(raw);
begin
    if raw is null or length(t) = 0 then
        return null;
    end if;

    begin
        if t ~ '^\d{4}-\d{2}-\d{2}' then
            -- ISO: take the date part and ignore any time/zone suffix.
            v := substring(t from 1 for 10)::date;
        else
            v := to_date(t, 'FMMM/FMDD/YYYY');
        end if;
    exception when others then
        return null;
    end;

    if v < date '1901-01-01' then
        return null;
    end if;

    return v;
end$$;


--------------------------------------------------------------------------------
-- 2. The columns
--------------------------------------------------------------------------------
alter table public.jobs
    add column if not exists customer_name text,
    add column if not exists start_date    date,
    add column if not exists due_date      date,
    add column if not exists job_type      text;

comment on column public.jobs.customer_name is
    'Customer, from the webhook''s "name" column. Display text — not trimmed to a code.';
comment on column public.jobs.start_date is
    'Job start date from Infusion. Null when Infusion had no date (it sends 1/0/1900).';
comment on column public.jobs.due_date is
    'Job due date from Infusion. Null when Infusion had no date (it sends 1/0/1900).';
comment on column public.jobs.job_type is
    'Job type from Infusion, e.g. SPARES. Upper-cased on ingest so downstream '
    'filters can match on a literal without worrying about the sender''s casing.';


--------------------------------------------------------------------------------
-- 3. The webhook
--------------------------------------------------------------------------------
-- Body carried forward from 141 (which moved the org lookup to org_secrets);
-- the only changes are the four new columns. Same signature, so the existing
-- grants survive CREATE OR REPLACE.
--
-- The new column names default to exactly what the sender already calls them,
-- so no organisations.jobs_import_map update is needed to switch this on. The
-- map keys stay available as the escape hatch if a sender's casing ever
-- differs.
--
-- Upsert semantics, deliberately NOT matching description's: description uses
-- coalesce(excluded, existing) because some payloads legitimately omit that
-- column. These four mirror the source system, so they're written plainly. If
-- a due date is cleared in Infusion it must clear here too — coalesce would
-- pin the stale date forever, which is worse than a null.
create or replace function public.ingest_jobs_via_webhook(p_api_key text, p_rows jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $function$
declare
    v_org bigint; v_map jsonb;
    v_code_col text; v_desc_col text; v_stat_col text; v_stat_map jsonb;
    v_cust_col text; v_start_col text; v_due_col text; v_type_col text;
    v_count integer := 0;
begin
    if p_api_key is null or length(p_api_key) < 16 then raise exception 'invalid api key'; end if;

    select s.organisation_id, o.jobs_import_map into v_org, v_map
      from public.org_secrets s join public.organisations o on o.id = s.organisation_id
     where s.jobs_webhook_key = p_api_key;
    if v_org is null then raise exception 'unknown api key'; end if;

    v_code_col  := coalesce(v_map->>'code_column',        'job_code');
    v_desc_col  := coalesce(v_map->>'description_column', 'description');
    v_stat_col  := coalesce(v_map->>'status_column',      'status');
    v_stat_map  := coalesce(v_map->'status_map',          '{}'::jsonb);
    v_cust_col  := coalesce(v_map->>'customer_column',    'name');
    v_start_col := coalesce(v_map->>'start_date_column',  'startdate');
    v_due_col   := coalesce(v_map->>'due_date_column',    'duedate');
    v_type_col  := coalesce(v_map->>'type_column',        'type');

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
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality as t(r, rn)
    cross join lateral (select trim(r->>v_code_col) as code) c
    where length(coalesce(code, '')) > 0
    order by code, rn desc
    on conflict (organisation_id, job_code) do update
        set description    = coalesce(excluded.description, jobs.description),
            status         = excluded.status,
            source         = 'webhook',
            last_synced_at = now(),
            updated_at     = now(),
            customer_name  = excluded.customer_name,
            start_date     = excluded.start_date,
            due_date       = excluded.due_date,
            job_type       = excluded.job_type;

    get diagnostics v_count = row_count;
    return jsonb_build_object('ok', true, 'organisation_id', v_org, 'count', v_count);
end$function$;

grant execute on function public.ingest_jobs_via_webhook(text, jsonb) to anon, authenticated;


--------------------------------------------------------------------------------
-- 4. Deliberately NOT done here
--------------------------------------------------------------------------------
-- The sample payload contains status ON HOLD (job 11388), which is not in
-- jobs_status_check and not in _canonical_job_status's allow-list — so it
-- currently lands as ACTIVE. Accepting it as a real status is a behaviour
-- change, not a data change: timesheet.js:2019 only resolves a scanned job
-- when status = 'ACTIVE', so an on-hold job would stop being scannable, and
-- configure.js's JOB_STATUSES list would need it too. That's a decision, so
-- it isn't bundled in here.
