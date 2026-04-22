-- 032_dept_codes_and_job_status_snapshot.sql
--
--   public.department_codes  — per-org lookup table for timesheet dept column
--   timesheet_entries.dept_code_id  — FK to department_codes
--   timesheet_entries.job_status_snapshot — frozen job status at submission time
--   snapshot_timesheet_job_statuses(p_timesheet_id) — called on submit
--
-- Safe to re-run.

--------------------------------------------------------------------------------
-- department_codes
--------------------------------------------------------------------------------

create table if not exists public.department_codes (
    id              bigserial primary key,
    organisation_id bigint not null references public.organisations (id) on delete cascade,
    code            text   not null,
    description     text,
    status          text   not null default 'ACTIVE'
        check (status in ('ACTIVE','INACTIVE')),
    source          text   not null default 'manual'
        check (source in ('manual','webhook','import')),
    last_synced_at  timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    unique (organisation_id, code)
);

create index if not exists department_codes_org_idx on public.department_codes (organisation_id);

alter table public.department_codes enable row level security;

drop policy if exists "admins manage org dept codes" on public.department_codes;
create policy "admins manage org dept codes"
    on public.department_codes for all
    to authenticated
    using (public.is_admin_of(organisation_id))
    with check (public.is_admin_of(organisation_id));

drop policy if exists "members read org dept codes" on public.department_codes;
create policy "members read org dept codes"
    on public.department_codes for select
    to authenticated
    using (
        public.is_admin_of(organisation_id)
        or exists (
            select 1 from public.users u
            where u.auth_user_id = auth.uid()
              and u.organisation_id = department_codes.organisation_id
        )
        or exists (
            select 1 from public.admins a
            where a.user_id = auth.uid()
              and a.organisation_id = department_codes.organisation_id
        )
    );

drop trigger if exists trg_department_codes_updated_at on public.department_codes;
create trigger trg_department_codes_updated_at
    before update on public.department_codes
    for each row execute function public.set_updated_at();

--------------------------------------------------------------------------------
-- organisations: webhook key + mapping for dept codes
--------------------------------------------------------------------------------

alter table public.organisations
    add column if not exists dept_codes_webhook_key  text unique,
    add column if not exists dept_codes_import_map   jsonb;

create unique index if not exists organisations_dept_codes_webhook_key_idx
    on public.organisations (dept_codes_webhook_key) where dept_codes_webhook_key is not null;

--------------------------------------------------------------------------------
-- ingest_dept_codes_via_webhook(p_api_key, p_rows)
--------------------------------------------------------------------------------

create or replace function public._canonical_dept_code_status(raw text, status_map jsonb)
returns text
language plpgsql immutable
as $$
declare mapped text;
begin
    if raw is null or length(trim(raw)) = 0 then return 'ACTIVE'; end if;
    mapped := coalesce(status_map->>raw, status_map->>trim(raw), upper(trim(raw)));
    if mapped in ('ACTIVE','INACTIVE') then return mapped; end if;
    return 'ACTIVE';
end$$;

create or replace function public.ingest_dept_codes_via_webhook(
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

    select id, dept_codes_import_map into v_org, v_map
    from public.organisations
    where dept_codes_webhook_key = p_api_key;

    if v_org is null then raise exception 'unknown api key'; end if;

    v_code_col := coalesce(v_map->>'code_column',        'code');
    v_desc_col := coalesce(v_map->>'description_column', 'description');
    v_stat_col := coalesce(v_map->>'status_column',      'status');
    v_stat_map := coalesce(v_map->'status_map',          '{}'::jsonb);

    insert into public.department_codes (
        organisation_id, code, description, status, source, last_synced_at
    )
    select
        v_org,
        trim(r->>v_code_col),
        nullif(trim(coalesce(r->>v_desc_col, '')), ''),
        public._canonical_dept_code_status(r->>v_stat_col, v_stat_map),
        'webhook',
        now()
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as r
    where length(trim(coalesce(r->>v_code_col, ''))) > 0
    on conflict (organisation_id, code) do update
        set description    = excluded.description,
            status         = excluded.status,
            source         = 'webhook',
            last_synced_at = now(),
            updated_at     = now();

    get diagnostics v_count = row_count;
    return jsonb_build_object('ok', true, 'organisation_id', v_org, 'count', v_count);
end$$;

grant execute on function public.ingest_dept_codes_via_webhook(text, jsonb) to anon, authenticated;

-- Extend rotate_import_key and save_import_mapping to handle dept_codes
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
    elsif p_kind = 'dept_codes' then
        update public.organisations set dept_codes_webhook_key = v_key where id = v_org;
    else
        raise exception 'unknown kind: %, expected jobs, tasks, or dept_codes', p_kind;
    end if;

    return v_key;
end$$;

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
    elsif p_kind = 'dept_codes' then
        update public.organisations set dept_codes_import_map = p_mapping where id = v_org;
    else
        raise exception 'unknown kind: %, expected jobs, tasks, or dept_codes', p_kind;
    end if;
end$$;

--------------------------------------------------------------------------------
-- timesheet_entries: add dept_code_id + job_status_snapshot
--------------------------------------------------------------------------------

alter table public.timesheet_entries
    add column if not exists dept_code_id         bigint references public.department_codes (id) on delete set null,
    add column if not exists job_status_snapshot   text;

--------------------------------------------------------------------------------
-- snapshot_timesheet_job_statuses(p_timesheet_id)
-- Called when a timesheet is submitted. Copies the current job status
-- from the jobs table onto each entry's job_status_snapshot field.
-- Once set, this value never changes — the archive shows the status
-- as it was at submission time.
--------------------------------------------------------------------------------

create or replace function public.snapshot_timesheet_job_statuses(
    p_timesheet_id bigint
)
returns void
language plpgsql security definer set search_path = public
as $$
begin
    update public.timesheet_entries te
    set job_status_snapshot = j.status
    from public.jobs j
    where te.timesheet_id = p_timesheet_id
      and te.job_id = j.id
      and te.job_status_snapshot is null;
end$$;

grant execute on function public.snapshot_timesheet_job_statuses(bigint) to authenticated;
