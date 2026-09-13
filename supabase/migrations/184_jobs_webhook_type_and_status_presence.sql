-- 184_jobs_webhook_type_and_status_presence.sql
--
-- The jobs sender gained a `jobtype` column, and renamed `status` to
-- `jobstatus`. Live payload, 2026-09-14:
--
--   { "jobid": "10037L", "title": "10037 Griffins Melter",
--     "jobtype": "*STD*", "jobstatus": "*COMP*" }
--
-- Two changes ride on that, and one of them is a repair.
--
--
-- 1. job_type COMES BACK TO THIS FEED -- reversing 180's FAULT 1
--
--   180 removed job_type from this function on the rule "one column, one
--   writer", and handed it to ingest_invoices_via_webhook (173/174) because
--   THAT was the feed carrying the value. The jobs sender had no `type` key at
--   all, so 169's write here won by nulling it -- SPARES appeared after an
--   invoice sync and vanished after a job sync.
--
--   Both halves of that have since changed. The jobs sender now carries the
--   value, and the invoices feed has stopped writing job_type (user,
--   2026-09-14, along with its jobs.status write -- both to be captured as a
--   migration of their own; 174's body in this repo still has both writes and
--   still says "safe to re-run", so it is NOT the live body).
--
--   So today NOTHING writes job_type, and a job typed SPARES after that change
--   never reaches po.spares_pipeline -- which populates from job_type alone
--   (ptl-purchase-orders 053).
--
--   This feed is also the RIGHT owner, which 180 could not have chosen: the
--   invoices feed only ever sees jobs that have been INVOICED, so an uninvoiced
--   spares job could never get a type from it. The jobs feed sees every job.
--
--   The null-fight that 180 fixed does not come back with it, because job_type
--   is written through the same presence-per-call test 180 built for
--   customer/dates: absent from the whole payload means "not part of this
--   feed's contract today", and the stored value is left alone.
--
--
-- 2. THE STATUS KEY RENAME, and why status now gets the same test
--
--   organisations.jobs_import_map says status_column = "status". The sender now
--   sends "jobstatus". So r->>v_stat_col is null for every row, and
--   _canonical_job_status(null, map) returns 'ACTIVE' -- by design, it never
--   rejects a row for a bad status. The function then returns 200 with a full
--   count while marking EVERY JOB ACTIVE.
--
--   That was masked while the invoices feed also wrote jobs.status: invoiced
--   jobs got their real status back on the next invoice sync and the two feeds
--   alternated, last-run-wins. That write is gone too, so this feed is the only
--   writer and nothing repairs it.
--
--   It matters beyond display. public/js/timesheet.js:2019 resolves a scanned
--   job as `job_code === jobCode && j.status === "ACTIVE"`, so every completed
--   job became clock-in-able again for as long as this ran; and
--   COMPLETED / DISPATCHED / INVOICED are the terminal statuses that outrank
--   everything in po.spares_pipeline's composition (042), so finished spares
--   jobs fall back to derivation and reappear as live stages.
--
--   THE FIX IS THE MAP, NOT THIS FILE. Run:
--
--     update public.organisations
--        set jobs_import_map = jsonb_set(jobs_import_map, '{status_column}', '"jobstatus"')
--      where jobs_import_map is not null;
--
--   180 argued against teaching the function a list of aliases to guess
--   between, and that still holds: an alias list papers over a broken map and
--   stops the map being the one place the answer lives. The same reasoning says
--   don't change the DEFAULT either -- a default documents one sender's shape,
--   and quietly moving it to match today's sender would hide the next rename
--   exactly the way this one hid.
--
--   What this file does instead is make the failure non-destructive and
--   visible. Status joins customer/start/due on the presence-per-call test, so
--   a payload with no status key leaves stored statuses ALONE rather than
--   flattening them to ACTIVE, and raises a WARNING naming the key it looked
--   for and the keys the payload actually had.
--
--   WARNING, not EXCEPTION, deliberately -- and this is the one judgement call
--   in the file. 180 raises for a missing job CODE because such a payload
--   accomplishes nothing at all; here the codes, descriptions and types still
--   ingest correctly, so aborting would throw away work that is fine. Frozen
--   statuses are stale, never wrong. If the jobs sync should instead stop dead
--   on a status-less payload, change the `raise warning` below to
--   `raise exception` -- nothing else needs to move.
--
--   NOTE the guard cannot catch a rename to a key the map DOES resolve, nor a
--   change in the status VOCABULARY. This org's status_map already translates
--   the asterisk forms (*ACTIVE* -> ACTIVE, *COMP* -> COMPLETED), so once the
--   map is fixed `*COMP*` lands as COMPLETED -- which is 180's "deliberately
--   NOT done here" item arriving by the route 180 named: an org-level
--   status_map, not a wider allow-list. Expect completed jobs to stop being
--   scannable when that happens. That is the intended behaviour, but it will
--   look like a regression to anyone who has been clocking onto one.
--
--
-- Insert-arm semantics, stated because they differ from the update arm: a job
-- seen for the FIRST time in a status-less payload still gets 'ACTIVE'. That is
-- the column default (030: not null default 'ACTIVE', CHECK-constrained) and
-- there is nothing to preserve on a row that does not exist yet.
--
-- Body is 180's verbatim plus v_type_col / v_has_type / v_has_stat and the
-- guarded assignments. Same signature, so existing grants survive.
-- Safe to re-run.


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
end$function$;

grant execute on function public.ingest_jobs_via_webhook(text, jsonb) to anon, authenticated;
