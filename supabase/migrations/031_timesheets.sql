-- 031_timesheets.sql
-- Weekly timesheet grid for all employees.
--
--   public.timesheets         — one row per employee per week
--   public.timesheet_entries  — one row per task-line on a timesheet,
--                               with mon–sun hours columns
--
-- RLS: employees can manage their own timesheets; managers can read
-- timesheets for employees in departments they manage; admins/devs
-- can read/write all in the org.
--
-- Safe to re-run.

--------------------------------------------------------------------------------
-- timesheets (header — one per employee per week)
--------------------------------------------------------------------------------

create table if not exists public.timesheets (
    id              bigserial primary key,
    organisation_id bigint not null references public.organisations (id) on delete cascade,
    user_id         bigint not null references public.users (id) on delete cascade,
    week_start      date   not null,
    status          text   not null default 'draft'
        check (status in ('draft','submitted','approved','rejected')),
    submitted_at    timestamptz,
    approved_by     bigint references public.users (id) on delete set null,
    approved_at     timestamptz,
    notes           text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    unique (user_id, week_start)
);

create index if not exists timesheets_org_idx   on public.timesheets (organisation_id);
create index if not exists timesheets_user_idx  on public.timesheets (user_id, week_start desc);

alter table public.timesheets enable row level security;

-- Employees can manage their own timesheets
drop policy if exists "users manage own timesheets" on public.timesheets;
create policy "users manage own timesheets"
    on public.timesheets for all
    to authenticated
    using (
        exists (
            select 1 from public.users u
            where u.id = timesheets.user_id
              and u.auth_user_id = auth.uid()
        )
    )
    with check (
        exists (
            select 1 from public.users u
            where u.id = timesheets.user_id
              and u.auth_user_id = auth.uid()
        )
    );

-- Admins can manage all timesheets in the org
drop policy if exists "admins manage org timesheets" on public.timesheets;
create policy "admins manage org timesheets"
    on public.timesheets for all
    to authenticated
    using (public.is_admin_of(organisation_id))
    with check (public.is_admin_of(organisation_id));

-- Managers can read timesheets from their departments
drop policy if exists "managers read dept timesheets" on public.timesheets;
create policy "managers read dept timesheets"
    on public.timesheets for select
    to authenticated
    using (
        exists (
            select 1 from public.users mgr
            where mgr.auth_user_id = auth.uid()
              and mgr.is_manager = true
              and mgr.organisation_id = timesheets.organisation_id
        )
    );

drop trigger if exists trg_timesheets_updated_at on public.timesheets;
create trigger trg_timesheets_updated_at
    before update on public.timesheets
    for each row execute function public.set_updated_at();

--------------------------------------------------------------------------------
-- timesheet_entries (one row per task-line)
--------------------------------------------------------------------------------

create table if not exists public.timesheet_entries (
    id              bigserial primary key,
    timesheet_id    bigint not null references public.timesheets (id) on delete cascade,
    job_id          bigint references public.jobs (id) on delete set null,
    task_id         bigint references public.tasks (id) on delete set null,
    description     text,
    sort_order      integer not null default 0,
    mon_hours       numeric(4,2) not null default 0,
    tue_hours       numeric(4,2) not null default 0,
    wed_hours       numeric(4,2) not null default 0,
    thu_hours       numeric(4,2) not null default 0,
    fri_hours       numeric(4,2) not null default 0,
    sat_hours       numeric(4,2) not null default 0,
    sun_hours       numeric(4,2) not null default 0,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index if not exists timesheet_entries_ts_idx on public.timesheet_entries (timesheet_id);

alter table public.timesheet_entries enable row level security;

-- Entries inherit access from their parent timesheet
drop policy if exists "users manage own entries" on public.timesheet_entries;
create policy "users manage own entries"
    on public.timesheet_entries for all
    to authenticated
    using (
        exists (
            select 1 from public.timesheets ts
            join public.users u on u.id = ts.user_id
            where ts.id = timesheet_entries.timesheet_id
              and u.auth_user_id = auth.uid()
        )
    )
    with check (
        exists (
            select 1 from public.timesheets ts
            join public.users u on u.id = ts.user_id
            where ts.id = timesheet_entries.timesheet_id
              and u.auth_user_id = auth.uid()
        )
    );

drop policy if exists "admins manage org entries" on public.timesheet_entries;
create policy "admins manage org entries"
    on public.timesheet_entries for all
    to authenticated
    using (
        exists (
            select 1 from public.timesheets ts
            where ts.id = timesheet_entries.timesheet_id
              and public.is_admin_of(ts.organisation_id)
        )
    )
    with check (
        exists (
            select 1 from public.timesheets ts
            where ts.id = timesheet_entries.timesheet_id
              and public.is_admin_of(ts.organisation_id)
        )
    );

drop policy if exists "managers read dept entries" on public.timesheet_entries;
create policy "managers read dept entries"
    on public.timesheet_entries for select
    to authenticated
    using (
        exists (
            select 1 from public.timesheets ts
            join public.users mgr on mgr.auth_user_id = auth.uid()
            where ts.id = timesheet_entries.timesheet_id
              and mgr.is_manager = true
              and mgr.organisation_id = ts.organisation_id
        )
    );

drop trigger if exists trg_timesheet_entries_updated_at on public.timesheet_entries;
create trigger trg_timesheet_entries_updated_at
    before update on public.timesheet_entries
    for each row execute function public.set_updated_at();

--------------------------------------------------------------------------------
-- get_or_create_timesheet(p_week_start)
-- Returns the current user's timesheet for a given week, creating it if needed.
--------------------------------------------------------------------------------

create or replace function public.get_or_create_timesheet(
    p_week_start date
)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
    v_user_id bigint;
    v_org_id  bigint;
    v_ts_id   bigint;
begin
    select u.id, u.organisation_id into v_user_id, v_org_id
    from public.users u
    where u.auth_user_id = auth.uid();

    if v_user_id is null then
        raise exception 'no linked employee record';
    end if;

    select id into v_ts_id
    from public.timesheets
    where user_id = v_user_id and week_start = p_week_start;

    if v_ts_id is null then
        insert into public.timesheets (organisation_id, user_id, week_start)
        values (v_org_id, v_user_id, p_week_start)
        returning id into v_ts_id;
    end if;

    return v_ts_id;
end$$;

grant execute on function public.get_or_create_timesheet(date) to authenticated;

--------------------------------------------------------------------------------
-- import_last_week_tasks(p_week_start)
-- Copies task rows (job, task, description, sort_order) from the previous
-- week's timesheet into the current week's, with all hours zeroed.
-- Returns the number of rows imported.
--------------------------------------------------------------------------------

create or replace function public.import_last_week_tasks(
    p_week_start date
)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
    v_user_id     bigint;
    v_org_id      bigint;
    v_current_ts  bigint;
    v_prev_ts     bigint;
    v_count       integer := 0;
begin
    select u.id, u.organisation_id into v_user_id, v_org_id
    from public.users u
    where u.auth_user_id = auth.uid();

    if v_user_id is null then
        raise exception 'no linked employee record';
    end if;

    -- Get or create current week
    select id into v_current_ts
    from public.timesheets
    where user_id = v_user_id and week_start = p_week_start;

    if v_current_ts is null then
        insert into public.timesheets (organisation_id, user_id, week_start)
        values (v_org_id, v_user_id, p_week_start)
        returning id into v_current_ts;
    end if;

    -- Find previous week
    select id into v_prev_ts
    from public.timesheets
    where user_id = v_user_id and week_start = p_week_start - interval '7 days';

    if v_prev_ts is null then
        return 0;
    end if;

    -- Copy entries (skip if current week already has entries)
    if exists (select 1 from public.timesheet_entries where timesheet_id = v_current_ts) then
        return 0;
    end if;

    insert into public.timesheet_entries (timesheet_id, job_id, task_id, description, sort_order)
    select v_current_ts, job_id, task_id, description, sort_order
    from public.timesheet_entries
    where timesheet_id = v_prev_ts
    order by sort_order, id;

    get diagnostics v_count = row_count;
    return v_count;
end$$;

grant execute on function public.import_last_week_tasks(date) to authenticated;
