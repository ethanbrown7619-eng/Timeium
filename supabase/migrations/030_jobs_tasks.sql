-- 030_jobs_tasks.sql
-- Temporium Unit 3 content.
--
--   public.jobs    — per-org list of job codes. Active first in every view.
--                    Statuses: ACTIVE, COMPLETED, DEP, DISPATCHED, INVOICED, PARTIAL.
--   public.tasks   — per-org list of task codes. Statuses: ACTIVE, COMPLETED.
--
--   organisations.jobs_webhook_key  / tasks_webhook_key   — random tokens
--   organisations.jobs_import_map   / tasks_import_map    — jsonb column &
--                                                          status mapping
--
--   ingest_jobs_via_webhook(p_api_key, p_rows)    — anon-callable, security
--   ingest_tasks_via_webhook(p_api_key, p_rows)     definer, matches org by
--                                                   webhook key and upserts.
--
--   rotate_import_key(p_kind)                — admin: regen a fresh key
--   save_import_mapping(p_kind, p_mapping)   — admin: persist the column map
--
-- Safe to re-run.

--------------------------------------------------------------------------------
-- jobs
--------------------------------------------------------------------------------

create table if not exists public.jobs (
    id              bigserial primary key,
    organisation_id bigint not null references public.organisations (id) on delete cascade,
    job_code        text   not null,
    description     text,
    status          text   not null default 'ACTIVE'
        check (status in ('ACTIVE','COMPLETED','DEP','DISPATCHED','INVOICED','PARTIAL')),
    source          text   not null default 'manual'
        check (source in ('manual','webhook','import')),
    last_synced_at  timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    unique (organisation_id, job_code)
);

create index if not exists jobs_org_idx         on public.jobs (organisation_id);
create index if not exists jobs_org_status_idx  on public.jobs (organisation_id, status);
create index if not exists jobs_description_idx on public.jobs using gin (to_tsvector('simple', coalesce(description, '')));

alter table public.jobs enable row level security;

drop policy if exists "admins manage org jobs" on public.jobs;
create policy "admins manage org jobs"
    on public.jobs for all
    to authenticated
    using (public.is_admin_of(organisation_id))
    with check (public.is_admin_of(organisation_id));

drop policy if exists "members read org jobs" on public.jobs;
create policy "members read org jobs"
    on public.jobs for select
    to authenticated
    using (
        public.is_admin_of(organisation_id)
        or exists (
            select 1 from public.users u
            where u.auth_user_id = auth.uid()
              and u.organisation_id = jobs.organisation_id
        )
        or exists (
            select 1 from public.admins a
            where a.user_id = auth.uid()
              and a.organisation_id = jobs.organisation_id
        )
    );

drop trigger if exists trg_jobs_updated_at on public.jobs;
create trigger trg_jobs_updated_at
    before update on public.jobs
    for each row execute function public.set_updated_at();

--------------------------------------------------------------------------------
-- tasks
--------------------------------------------------------------------------------

create table if not exists public.tasks (
    id              bigserial primary key,
    organisation_id bigint not null references public.organisations (id) on delete cascade,
    task_code       text   not null,
    description     text,
    status          text   not null default 'ACTIVE'
        check (status in ('ACTIVE','COMPLETED')),
    source          text   not null default 'manual'
        check (source in ('manual','webhook','import')),
    last_synced_at  timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    unique (organisation_id, task_code)
);

create index if not exists tasks_org_idx        on public.tasks (organisation_id);
create index if not exists tasks_org_status_idx on public.tasks (organisation_id, status);

alter table public.tasks enable row level security;

drop policy if exists "admins manage org tasks" on public.tasks;
create policy "admins manage org tasks"
    on public.tasks for all
    to authenticated
    using (public.is_admin_of(organisation_id))
    with check (public.is_admin_of(organisation_id));

drop policy if exists "members read org tasks" on public.tasks;
create policy "members read org tasks"
    on public.tasks for select
    to authenticated
    using (
        public.is_admin_of(organisation_id)
        or exists (
            select 1 from public.users u
            where u.auth_user_id = auth.uid()
              and u.organisation_id = tasks.organisation_id
        )
        or exists (
            select 1 from public.admins a
            where a.user_id = auth.uid()
              and a.organisation_id = tasks.organisation_id
        )
    );

drop trigger if exists trg_tasks_updated_at on public.tasks;
create trigger trg_tasks_updated_at
    before update on public.tasks
    for each row execute function public.set_updated_at();

--------------------------------------------------------------------------------
-- organisations: per-org webhook keys + column mapping
--
--   jobs_import_map / tasks_import_map jsonb shape:
--     {
--       "code_column":        "Job Number",
--       "description_column": "Description",
--       "status_column":      "Status",
--       "status_map": {
--         "Active":     "ACTIVE",
--         "Completed":  "COMPLETED",
--         "Invoiced":   "INVOICED",
--         ...
--       }
--     }
--
-- Anything missing from status_map falls back to uppercase-trimmed source
-- value, and anything that still doesn't match a canonical status becomes
-- ACTIVE (never reject a row for a bad status).
--------------------------------------------------------------------------------

alter table public.organisations
    add column if not exists jobs_webhook_key  text unique,
    add column if not exists jobs_import_map   jsonb,
    add column if not exists tasks_webhook_key text unique,
    add column if not exists tasks_import_map  jsonb;

-- Fast lookup by webhook key — the ingest path hits this on every call.
create unique index if not exists organisations_jobs_webhook_key_idx
    on public.organisations (jobs_webhook_key) where jobs_webhook_key is not null;
create unique index if not exists organisations_tasks_webhook_key_idx
    on public.organisations (tasks_webhook_key) where tasks_webhook_key is not null;

--------------------------------------------------------------------------------
-- rotate_import_key(p_kind)
--   Generates a fresh random key for the current admin's org. 'jobs' | 'tasks'.
--   Returns the new key.
--------------------------------------------------------------------------------

create or replace function public.rotate_import_key(
    p_kind   text,
    p_org_id bigint default null
)
returns text
language plpgsql security definer set search_path = public
as $$
declare
    v_org bigint;
    v_key text;
begin
    v_org := public.resolve_org_id(p_org_id);
    if not public.is_admin_of(v_org) then
        raise exception 'not an admin of organisation %', v_org;
    end if;

    v_key := replace(gen_random_uuid()::text, '-', '')
          || replace(gen_random_uuid()::text, '-', '');

    if p_kind = 'jobs' then
        update public.organisations set jobs_webhook_key = v_key where id = v_org;
    elsif p_kind = 'tasks' then
        update public.organisations set tasks_webhook_key = v_key where id = v_org;
    else
        raise exception 'unknown kind: %, expected jobs or tasks', p_kind;
    end if;

    return v_key;
end$$;

grant execute on function public.rotate_import_key(text, bigint) to authenticated;

--------------------------------------------------------------------------------
-- save_import_mapping(p_kind, p_mapping)
--   Persist a jsonb mapping for the current admin's org.
--------------------------------------------------------------------------------

create or replace function public.save_import_mapping(
    p_kind    text,
    p_mapping jsonb,
    p_org_id  bigint default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    v_org bigint;
begin
    v_org := public.resolve_org_id(p_org_id);
    if not public.is_admin_of(v_org) then
        raise exception 'not an admin of organisation %', v_org;
    end if;

    if p_kind = 'jobs' then
        update public.organisations set jobs_import_map = p_mapping where id = v_org;
    elsif p_kind = 'tasks' then
        update public.organisations set tasks_import_map = p_mapping where id = v_org;
    else
        raise exception 'unknown kind: %, expected jobs or tasks', p_kind;
    end if;
end$$;

grant execute on function public.save_import_mapping(text, jsonb, bigint) to authenticated;

--------------------------------------------------------------------------------
-- _canonical_job_status / _canonical_task_status helpers
--------------------------------------------------------------------------------

create or replace function public._canonical_job_status(raw text, status_map jsonb)
returns text
language plpgsql immutable
as $$
declare
    mapped text;
begin
    if raw is null or length(trim(raw)) = 0 then
        return 'ACTIVE';
    end if;
    mapped := coalesce(status_map->>raw, status_map->>trim(raw), upper(trim(raw)));
    if mapped in ('ACTIVE','COMPLETED','DEP','DISPATCHED','INVOICED','PARTIAL') then
        return mapped;
    end if;
    return 'ACTIVE';
end$$;

create or replace function public._canonical_task_status(raw text, status_map jsonb)
returns text
language plpgsql immutable
as $$
declare
    mapped text;
begin
    if raw is null or length(trim(raw)) = 0 then
        return 'ACTIVE';
    end if;
    mapped := coalesce(status_map->>raw, status_map->>trim(raw), upper(trim(raw)));
    if mapped in ('ACTIVE','COMPLETED') then
        return mapped;
    end if;
    return 'ACTIVE';
end$$;

--------------------------------------------------------------------------------
-- ingest_jobs_via_webhook(p_api_key, p_rows)
--   Anon-callable. Looks up the org by webhook key, applies the stored column
--   mapping, and upserts every row. Returns a summary.
--
--   p_rows is an array of objects with ORIGINAL column names from the source
--   sheet, e.g. [{ "Job Number": "J123", "Description": "...", "Status": "..." }]
--------------------------------------------------------------------------------

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
        set description    = excluded.description,
            status         = excluded.status,
            source         = 'webhook',
            last_synced_at = now(),
            updated_at     = now();

    get diagnostics v_count = row_count;
    return jsonb_build_object('ok', true, 'organisation_id', v_org, 'count', v_count);
end$$;

grant execute on function public.ingest_jobs_via_webhook(text, jsonb) to anon, authenticated;

--------------------------------------------------------------------------------
-- ingest_tasks_via_webhook(p_api_key, p_rows)
--------------------------------------------------------------------------------

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
        set description    = excluded.description,
            status         = excluded.status,
            source         = 'webhook',
            last_synced_at = now(),
            updated_at     = now();

    get diagnostics v_count = row_count;
    return jsonb_build_object('ok', true, 'organisation_id', v_org, 'count', v_count);
end$$;

grant execute on function public.ingest_tasks_via_webhook(text, jsonb) to anon, authenticated;

--------------------------------------------------------------------------------
-- suggest_jobs(p_query, p_limit)
--   Autosuggest helper for the timesheet job-code field. Active jobs first,
--   then matches in code or description. Case-insensitive contains.
--------------------------------------------------------------------------------

create or replace function public.suggest_jobs(
    p_query  text,
    p_limit  integer default 10,
    p_org_id bigint default null
)
returns table (
    id          bigint,
    job_code    text,
    description text,
    status      text
)
language plpgsql stable security definer set search_path = public
as $$
declare
    v_org bigint;
    v_q   text;
begin
    v_org := public.resolve_org_id(p_org_id);
    v_q   := '%' || lower(coalesce(p_query, '')) || '%';

    return query
    select j.id, j.job_code, j.description, j.status
    from public.jobs j
    where j.organisation_id = v_org
      and (
        lower(j.job_code)                   like v_q
        or lower(coalesce(j.description,'')) like v_q
      )
    order by
        case when j.status = 'ACTIVE' then 0 else 1 end,
        j.job_code
    limit greatest(1, least(coalesce(p_limit, 10), 50));
end$$;

grant execute on function public.suggest_jobs(text, integer, bigint) to authenticated;
