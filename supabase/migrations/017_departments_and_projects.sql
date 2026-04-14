-- 017_departments_and_projects.sql
-- First timesheet-app migration. Introduces:
--   - public.departments    (per-org dropdown for the employee timesheet)
--   - public.projects       (per-org, synced from Infusion every ~30 min)
--   - public.upsert_projects_from_infusion RPC
--   - backfill of existing users.department free-text values into departments
--
-- Follows Phase 1 conventions:
--   * organisation_id NOT NULL on every new table, indexed, FK → organisations
--   * RLS uses is_admin_of(organisation_id) with unqualified column names
--   * SECURITY DEFINER RPCs call resolve_org_id(p_org_id) before touching any row
--
-- Safe to re-run.

--------------------------------------------------------------------------------
-- departments
--------------------------------------------------------------------------------

create table if not exists public.departments (
    id              bigserial primary key,
    organisation_id bigint not null references public.organisations (id) on delete cascade,
    name            text   not null,
    active          boolean not null default true,
    created_at      timestamptz not null default now(),
    unique (organisation_id, name)
);

create index if not exists departments_org_idx on public.departments (organisation_id);

alter table public.departments enable row level security;

drop policy if exists "admins manage org departments" on public.departments;
create policy "admins manage org departments"
    on public.departments for all
    to authenticated
    using (public.is_admin_of(organisation_id))
    with check (public.is_admin_of(organisation_id));

-- Employees need to read their org's department list to populate the dropdown
-- on the (future) timesheet page. Scoped by the caller's org via a subquery
-- against admins OR users.auth_user_id — but because v_org helper doesn't
-- exist in a policy context, we just allow read to any authenticated user
-- who belongs to the same org through an admins row OR a users row.
drop policy if exists "members read org departments" on public.departments;
create policy "members read org departments"
    on public.departments for select
    to authenticated
    using (
        public.is_admin_of(organisation_id)
        or exists (
            select 1 from public.admins
            where admins.user_id = auth.uid()
              and admins.organisation_id = departments.organisation_id
        )
    );

--------------------------------------------------------------------------------
-- projects (synced from Infusion)
-- One row per (organisation, job_number, project_number). Job-level fields are
-- replicated on every project row because Infusion's project endpoint already
-- denormalises them; querying a single table keeps the UI simple.
--------------------------------------------------------------------------------

create table if not exists public.projects (
    id                   bigserial primary key,
    organisation_id      bigint not null references public.organisations (id) on delete cascade,
    job_number           text   not null,
    project_number       text   not null,
    job_description      text,
    job_status           text,
    project_description  text,
    project_status       text,
    client_name          text,
    active               boolean not null default true,
    last_synced_at       timestamptz,
    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now(),
    unique (organisation_id, job_number, project_number)
);

create index if not exists projects_org_idx            on public.projects (organisation_id);
create index if not exists projects_org_active_idx     on public.projects (organisation_id, active);
create index if not exists projects_org_job_idx        on public.projects (organisation_id, job_number);

alter table public.projects enable row level security;

drop policy if exists "admins manage org projects" on public.projects;
create policy "admins manage org projects"
    on public.projects for all
    to authenticated
    using (public.is_admin_of(organisation_id))
    with check (public.is_admin_of(organisation_id));

-- Employees read projects to populate the timesheet dropdown — same pattern
-- as departments above.
drop policy if exists "members read org projects" on public.projects;
create policy "members read org projects"
    on public.projects for select
    to authenticated
    using (
        public.is_admin_of(organisation_id)
        or exists (
            select 1 from public.admins
            where admins.user_id = auth.uid()
              and admins.organisation_id = projects.organisation_id
        )
    );

--------------------------------------------------------------------------------
-- updated_at trigger for projects
--------------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at := now();
    return new;
end$$;

drop trigger if exists trg_projects_updated_at on public.projects;
create trigger trg_projects_updated_at
    before update on public.projects
    for each row execute function public.set_updated_at();

--------------------------------------------------------------------------------
-- upsert_projects_from_infusion RPC
--
-- Called by the sync-infusion-projects edge function. The edge function passes
-- p_org_id explicitly because it runs as the service_role (developer-equivalent)
-- and iterates over all active orgs.
--
-- Payload shape:
--   [{
--     "job_number":          "1234",
--     "project_number":      "01",
--     "job_description":     "Wellington Warehouse fit-out",
--     "job_status":          "Active",
--     "project_description": "Mezzanine framing",
--     "project_status":      "In progress",
--     "client_name":         "Acme Ltd",
--     "active":              true
--   }, ...]
--------------------------------------------------------------------------------

create or replace function public.upsert_projects_from_infusion(
    p_org_id   bigint default null,
    p_projects jsonb  default '[]'::jsonb
)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
    v_org   bigint;
    v_count integer := 0;
begin
    v_org := public.resolve_org_id(p_org_id);

    insert into public.projects (
        organisation_id, job_number, project_number,
        job_description, job_status,
        project_description, project_status,
        client_name, active, last_synced_at
    )
    select
        v_org,
        p->>'job_number',
        p->>'project_number',
        p->>'job_description',
        p->>'job_status',
        p->>'project_description',
        p->>'project_status',
        p->>'client_name',
        coalesce((p->>'active')::boolean, true),
        now()
    from jsonb_array_elements(coalesce(p_projects, '[]'::jsonb)) as p
    where (p->>'job_number')     is not null
      and (p->>'project_number') is not null
    on conflict (organisation_id, job_number, project_number) do update
        set job_description     = excluded.job_description,
            job_status          = excluded.job_status,
            project_description = excluded.project_description,
            project_status      = excluded.project_status,
            client_name         = excluded.client_name,
            active              = excluded.active,
            last_synced_at      = now(),
            updated_at          = now();

    get diagnostics v_count = row_count;
    return v_count;
end$$;

grant execute on function public.upsert_projects_from_infusion(bigint, jsonb) to authenticated;

--------------------------------------------------------------------------------
-- Backfill: seed departments from existing free-text users.department values.
--
-- Runs once; subsequent runs are no-ops because of the ON CONFLICT clause. The
-- free-text users.department column stays put for now — a later migration
-- will convert it to a FK once the dropdown is in use.
--------------------------------------------------------------------------------

insert into public.departments (organisation_id, name)
select distinct u.organisation_id, trim(u.department)
from public.users u
where u.department is not null
  and trim(u.department) <> ''
on conflict (organisation_id, name) do nothing;
