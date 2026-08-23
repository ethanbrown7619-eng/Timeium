-- 180_jobs_webhook_lean_payload.sql
--
-- Two failure modes on the jobs webhook, both of which return 200 OK today.
--
-- The trigger was a live sender payload shaped:
--
--   [ { "jobid": "10939000", "title": "10939 Nestle Project Millenium - Overall",
--       "status": "*ACTIVE*" }, ... ]
--
-- i.e. THREE keys. Migration 169 added four more (name / startdate / duedate /
-- type) on the assumption they always ride along. They don't.
--
--
-- FAULT 1 -- job_type has another owner, and this feed was fighting it
--
--   public.jobs.job_type is written by ingest_invoices_via_webhook (173, body
--   carried forward by 174), off each invoice line's `jobtype` column. That is
--   where SPARES comes from. 169 then had the jobs feed write job_type as
--   well, so the two feeds overwrite each other and last-run-wins -- and since
--   the jobs sender has no `type` key at all, the jobs feed wins by nulling
--   it. SPARES appears after an invoice sync and vanishes after a job sync.
--
--   173 had already drawn this line, in the other direction: "customer_name is
--   absent from both the insert and the update: this feed must never touch it
--   -- jobs sends the CUSTOMER, invoices send the DEBTOR." job_type is the
--   mirror of that rule, and 169 missed it.
--
--   Fix: job_type is absent from both the insert and the update here. One
--   column, one writer. Invoices sends the TYPE.
--
--
-- FAULT 2 -- a lean payload silently wipes the remaining 169 columns
--
--   169 writes customer_name / start_date / due_date PLAINLY on conflict, on
--   purpose: a date cleared in Infusion has to clear here too, so coalesce()
--   was rejected. Correct -- but it cannot tell "the sender cleared this
--   field" from "the sender never sent this field". A three-key payload
--   therefore nulls all three on EVERY job in one call. Same shape of trap as
--   the PO worker: a narrower payload than expected, ingested as
--   authoritative.
--
--   These three stay on this feed rather than moving to invoices, because
--   invoices only ever sees jobs that have been invoiced -- an uninvoiced job
--   would never get a customer or a date at all. So the answer here isn't
--   ownership, it's presence: decide per CALL, not per row. If a key is absent
--   from the entire payload, that column is not part of this feed's contract
--   today and is left alone. If the key is present anywhere, the column is
--   authoritative again and an empty value still clears -- 169's semantics,
--   unchanged.
--
--
-- FAULT 3 -- a broken column map succeeds with zero rows
--
--   v_code_col defaults to 'job_code', but this sender's key is 'jobid'. That
--   only works because organisations.jobs_import_map says code_column=jobid.
--   If that map is ever lost, reset, or edited, then trim(r->>'job_code') is
--   null for every row, the length(code) > 0 filter drops all of them, and the
--   function returns {"ok": true, "count": 0}. Power Automate sees 200,
--   reports success, and the jobs table quietly stops moving -- which is
--   exactly the "the data is there but the database isn't picking it up"
--   symptom, with nothing in any log to say so.
--
--   Fix: rows in, zero rows out is an error, and the error names the keys the
--   payload actually had so the map can be repaired without a repro.
--
--   Deliberately NOT auto-guessing aliases (jobid/job_no/code/...). Guessing
--   would paper over a broken map and make the map stop being the one place
--   the answer lives.
--
--
-- Deliberately NOT done here (see also 169 section 4): the status vocabulary.
-- `*COMP*` is not in _canonical_job_status's allow-list, so unless the org's
-- status_map translates it, every completed job in the payload above ingests
-- as ACTIVE and stays scannable. Teaching the function Infusion's asterisk
-- vocabulary would flip a large number of live jobs out of ACTIVE -- a
-- behaviour decision, not a bug fix, so it stays out of this migration.
--
-- Safe to re-run. Same signature, so existing grants survive.


create or replace function public.ingest_jobs_via_webhook(p_api_key text, p_rows jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $function$
declare
    v_org bigint; v_map jsonb;
    v_code_col text; v_desc_col text; v_stat_col text; v_stat_map jsonb;
    v_cust_col text; v_start_col text; v_due_col text;
    v_has_cust boolean; v_has_start boolean; v_has_due boolean;
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
    -- NOTE: there is deliberately no `type` mapping. See FAULT 1 in the header.

    -- Which of these three is this payload actually carrying? One pass, whole
    -- payload: present in ANY row means the field is in play for this call, so
    -- a row that omits it is a genuine clear. Present in NO row means the
    -- sender is not sending it at all and the stored value is left alone.
    select coalesce(bool_or(jsonb_typeof(r) = 'object' and r ? v_cust_col),  false),
           coalesce(bool_or(jsonb_typeof(r) = 'object' and r ? v_start_col), false),
           coalesce(bool_or(jsonb_typeof(r) = 'object' and r ? v_due_col),   false)
      into v_has_cust, v_has_start, v_has_due
      from jsonb_array_elements(v_rows) as t(r);

    -- job_type appears in neither the column list nor the update below: it
    -- belongs to ingest_invoices_via_webhook. See FAULT 1 in the header.
    insert into public.jobs (
        organisation_id, job_code, description, status, source, last_synced_at,
        customer_name, start_date, due_date
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
        public._parse_infusion_date(r->>v_due_col)
    from jsonb_array_elements(v_rows) with ordinality as t(r, rn)
    cross join lateral (select trim(r->>v_code_col) as code) c
    where length(coalesce(code, '')) > 0
    order by code, rn desc
    on conflict (organisation_id, job_code) do update
        set description    = coalesce(excluded.description, jobs.description),
            status         = excluded.status,
            source         = 'webhook',
            last_synced_at = now(),
            updated_at     = now(),
            customer_name  = case when v_has_cust  then excluded.customer_name else jobs.customer_name end,
            start_date     = case when v_has_start then excluded.start_date    else jobs.start_date    end,
            due_date       = case when v_has_due   then excluded.due_date      else jobs.due_date      end;

    get diagnostics v_count = row_count;

    -- Rows arrived and none of them had a job code. That is a broken column
    -- map, never a legitimate payload, and it must not look like success.
    if v_in > 0 and v_count = 0 then
        select string_agg(k, ', ' order by k) into v_keys
          from jsonb_object_keys(case when jsonb_typeof(v_rows->0) = 'object'
                                      then v_rows->0 else '{}'::jsonb end) as k;
        raise exception
            'jobs webhook: % row(s) received but none had a job code. '
            'Looked for key "%" (organisations.jobs_import_map -> code_column). '
            'First row actually has: [%]',
            v_in, v_code_col, coalesce(v_keys, '(no keys)');
    end if;

    return jsonb_build_object(
        'ok', true, 'organisation_id', v_org,
        'received', v_in, 'count', v_count,
        'columns_in_payload', jsonb_build_object(
            'customer_name', v_has_cust, 'start_date', v_has_start,
            'due_date', v_has_due));
end$function$;

grant execute on function public.ingest_jobs_via_webhook(text, jsonb) to anon, authenticated;
