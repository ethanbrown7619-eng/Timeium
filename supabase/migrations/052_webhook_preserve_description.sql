-- 052_webhook_preserve_description.sql
-- When webhook data has no description column, preserve the existing description
-- instead of overwriting it with NULL.

create or replace function public.ingest_jobs_via_webhook(
    p_api_key text,
    p_rows    jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
    v_org      bigint;
    v_map      jsonb;
    v_code_col text;
    v_desc_col text;
    v_stat_col text;
    v_stat_map jsonb;
    v_count    integer := 0;
begin
    if p_api_key is null or length(p_api_key) < 16 then
        raise exception 'invalid api key';
    end if;

    select id, jobs_import_map into v_org, v_map
    from public.organisations
    where jobs_webhook_key = p_api_key;

    if v_org is null then
        raise exception 'unknown api key';
    end if;

    v_code_col := coalesce(v_map->>'code_column',        'job_code');
    v_desc_col := coalesce(v_map->>'description_column', 'description');
    v_stat_col := coalesce(v_map->>'status_column',      'status');
    v_stat_map := coalesce(v_map->'status_map',          '{}'::jsonb);

    insert into public.jobs (
        organisation_id, job_code, description, status, source, last_synced_at
    )
    select
        v_org,
        trim(r->>v_code_col),
        nullif(trim(coalesce(r->>v_desc_col, '')), ''),
        public._canonical_job_status(r->>v_stat_col, v_stat_map),
        'webhook',
        now()
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as r
    where length(trim(coalesce(r->>v_code_col, ''))) > 0
    on conflict (organisation_id, job_code) do update
        set description    = coalesce(excluded.description, jobs.description),
            status         = excluded.status,
            source         = 'webhook',
            last_synced_at = now(),
            updated_at     = now();

    get diagnostics v_count = row_count;
    return jsonb_build_object('ok', true, 'organisation_id', v_org, 'count', v_count);
end$$;

grant execute on function public.ingest_jobs_via_webhook(text, jsonb) to anon, authenticated;

create or replace function public.ingest_tasks_via_webhook(
    p_api_key text,
    p_rows    jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
    v_org      bigint;
    v_map      jsonb;
    v_code_col text;
    v_desc_col text;
    v_stat_col text;
    v_stat_map jsonb;
    v_count    integer := 0;
begin
    if p_api_key is null or length(p_api_key) < 16 then
        raise exception 'invalid api key';
    end if;

    select id, tasks_import_map into v_org, v_map
    from public.organisations
    where tasks_webhook_key = p_api_key;

    if v_org is null then
        raise exception 'unknown api key';
    end if;

    v_code_col := coalesce(v_map->>'code_column',        'task_code');
    v_desc_col := coalesce(v_map->>'description_column', 'description');
    v_stat_col := coalesce(v_map->>'status_column',      'status');
    v_stat_map := coalesce(v_map->'status_map',          '{}'::jsonb);

    insert into public.tasks (
        organisation_id, task_code, description, status, source, last_synced_at
    )
    select
        v_org,
        trim(r->>v_code_col),
        nullif(trim(coalesce(r->>v_desc_col, '')), ''),
        public._canonical_task_status(r->>v_stat_col, v_stat_map),
        'webhook',
        now()
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as r
    where length(trim(coalesce(r->>v_code_col, ''))) > 0
    on conflict (organisation_id, task_code) do update
        set description    = coalesce(excluded.description, tasks.description),
            status         = excluded.status,
            source         = 'webhook',
            last_synced_at = now(),
            updated_at     = now();

    get diagnostics v_count = row_count;
    return jsonb_build_object('ok', true, 'organisation_id', v_org, 'count', v_count);
end$$;

grant execute on function public.ingest_tasks_via_webhook(text, jsonb) to anon, authenticated;
