-- 041_leave_balances.sql
-- Leave balance tracking aligned with NZ Holidays Act 2003.
--
-- This migration sets up the schema for tracking leave entitlements and
-- balances. Actual accrual automation (rolling 52-week earnings ledger,
-- OWP vs AWE calculations) is left for a follow-up migration. This gives
-- us the foundation to display balances and log usage.
--
-- NZ reference (Holidays Act 2003):
--   Annual Leave (s.16):         4 weeks per year, granted on anniversary,
--                                continuously accrues as 8% of gross earnings.
--   Sick Leave (s.65-68):        10 days per year, available at 6 months,
--                                capped at 20 days max carryover.
--   Bereavement Leave (s.69-72): 3 days per qualifying event (immediate
--                                family), 1 day other. Not a balance — per event.
--   Family Violence Leave:       10 days per 12-month period, resets annually.
--   Alternative Holiday (s.56):  Day-in-lieu for working a public holiday.
--   Public Holidays (s.44-55):   11 statutory days, paid at 1.5x if worked.
--
-- Safe to re-run.

--------------------------------------------------------------------------------
-- users.start_date
--   Used for anniversary-based entitlement calculations (annual leave at
--   12 months, sick/bereavement/family violence at 6 months).
--------------------------------------------------------------------------------

alter table public.users
    add column if not exists start_date date;

--------------------------------------------------------------------------------
-- leave_types
--   Seeded with the six NZ leave categories. unit = 'hours' or 'days'.
--     annual:           tracked in hours (salaried) or weeks (waged)
--     sick:             tracked in days (most common)
--     bereavement:      tracked in days — per-event, not accrued
--     family_violence:  10 days per year, resets annually
--     alternative:      day-in-lieu counter
--     public_holiday:   statutory — usage log only, not a balance
--------------------------------------------------------------------------------

create table if not exists public.leave_types (
    id              bigserial primary key,
    organisation_id bigint not null references public.organisations (id) on delete cascade,
    code            text   not null,
    name            text   not null,
    unit            text   not null default 'hours'
        check (unit in ('hours', 'days')),
    default_entitlement numeric(10,2) not null default 0,
    max_carryover       numeric(10,2),
    accrues             boolean not null default true,
    resets_annually     boolean not null default false,
    sort_order          int not null default 0,
    active              boolean not null default true,
    created_at      timestamptz not null default now(),
    unique (organisation_id, code)
);

create index if not exists leave_types_org_idx on public.leave_types (organisation_id);

alter table public.leave_types enable row level security;

drop policy if exists "admins manage leave_types" on public.leave_types;
create policy "admins manage leave_types"
    on public.leave_types for all
    using (public.is_admin_of(organisation_id))
    with check (public.is_admin_of(organisation_id));

drop policy if exists "members read leave_types" on public.leave_types;
create policy "members read leave_types"
    on public.leave_types for select
    using (
        exists (
            select 1 from public.users
            where users.organisation_id = leave_types.organisation_id
              and users.auth_user_id = auth.uid()
        )
        or public.is_admin_of(organisation_id)
    );

--------------------------------------------------------------------------------
-- leave_balances
--   One row per (employee, leave_type).
--   balance_hours: current available balance (in the unit of the leave type)
--   accrued_hours: total ever accrued (for reporting)
--   used_hours:    total ever taken (for reporting)
--   last_accrual_at: when the accrual job last ran for this row
--------------------------------------------------------------------------------

create table if not exists public.leave_balances (
    id              bigserial primary key,
    organisation_id bigint not null references public.organisations (id) on delete cascade,
    user_id         bigint not null references public.users (id) on delete cascade,
    leave_type_id   bigint not null references public.leave_types (id) on delete cascade,
    balance         numeric(10,2) not null default 0,
    accrued_total   numeric(10,2) not null default 0,
    used_total      numeric(10,2) not null default 0,
    last_accrual_at timestamptz,
    updated_at      timestamptz not null default now(),
    unique (user_id, leave_type_id)
);

create index if not exists leave_balances_user_idx on public.leave_balances (user_id);
create index if not exists leave_balances_org_idx on public.leave_balances (organisation_id);

alter table public.leave_balances enable row level security;

drop policy if exists "admins manage leave_balances" on public.leave_balances;
create policy "admins manage leave_balances"
    on public.leave_balances for all
    using (public.is_admin_of(organisation_id))
    with check (public.is_admin_of(organisation_id));

drop policy if exists "employees read own leave_balances" on public.leave_balances;
create policy "employees read own leave_balances"
    on public.leave_balances for select
    using (
        exists (
            select 1 from public.users
            where users.id = leave_balances.user_id
              and users.auth_user_id = auth.uid()
        )
        or public.is_admin_of(organisation_id)
    );

--------------------------------------------------------------------------------
-- leave_transactions
--   Append-only ledger of changes to a leave balance. Every accrual,
--   usage, and manual adjustment gets a row. Future: auto-populated when
--   timesheet entries are saved against leave-flagged jobs.
--------------------------------------------------------------------------------

create table if not exists public.leave_transactions (
    id              bigserial primary key,
    organisation_id bigint not null references public.organisations (id) on delete cascade,
    user_id         bigint not null references public.users (id) on delete cascade,
    leave_type_id   bigint not null references public.leave_types (id) on delete cascade,
    kind            text   not null
        check (kind in ('accrual', 'usage', 'adjustment', 'carryover', 'reset')),
    amount          numeric(10,2) not null,
    effective_date  date   not null default current_date,
    note            text,
    timesheet_entry_id bigint,
    created_by      uuid,
    created_at      timestamptz not null default now()
);

create index if not exists leave_tx_user_idx on public.leave_transactions (user_id, effective_date);
create index if not exists leave_tx_org_idx  on public.leave_transactions (organisation_id);

alter table public.leave_transactions enable row level security;

drop policy if exists "admins manage leave_transactions" on public.leave_transactions;
create policy "admins manage leave_transactions"
    on public.leave_transactions for all
    using (public.is_admin_of(organisation_id))
    with check (public.is_admin_of(organisation_id));

drop policy if exists "employees read own leave_transactions" on public.leave_transactions;
create policy "employees read own leave_transactions"
    on public.leave_transactions for select
    using (
        exists (
            select 1 from public.users
            where users.id = leave_transactions.user_id
              and users.auth_user_id = auth.uid()
        )
        or public.is_admin_of(organisation_id)
    );

--------------------------------------------------------------------------------
-- jobs.leave_type_id
--   Links leave-flagged jobs to a leave type so time logged against the
--   job deducts from the right balance.
--------------------------------------------------------------------------------

alter table public.jobs
    add column if not exists leave_type_id bigint
        references public.leave_types (id) on delete set null;

create index if not exists jobs_leave_type_idx on public.jobs (leave_type_id);

--------------------------------------------------------------------------------
-- seed_default_leave_types
--   Creates the standard NZ leave types for an organisation. Idempotent
--   (uses on conflict do nothing on the org+code unique constraint).
--   Admins can rename/deactivate; codes are stable identifiers.
--------------------------------------------------------------------------------

create or replace function public.seed_default_leave_types(p_org_id bigint)
returns void
language plpgsql security definer set search_path = public
as $$
begin
    insert into public.leave_types
        (organisation_id, code, name, unit, default_entitlement, max_carryover,
         accrues, resets_annually, sort_order)
    values
        (p_org_id, 'ANNUAL',     'Annual Leave',           'hours', 160, null,
         true,  false, 10),
        (p_org_id, 'SICK',       'Sick Leave',             'days',  10,  20,
         true,  false, 20),
        (p_org_id, 'BEREAVEMENT','Bereavement Leave',      'days',  0,   null,
         false, false, 30),
        (p_org_id, 'FAMILY_VIOLENCE','Family Violence Leave','days', 10, 0,
         true,  true,  40),
        (p_org_id, 'ALTERNATIVE','Alternative Day',        'days',  0,   null,
         false, false, 50),
        (p_org_id, 'PUBLIC_HOLIDAY','Public Holiday',      'days',  0,   null,
         false, false, 60)
    on conflict (organisation_id, code) do nothing;
end;
$$;

grant execute on function public.seed_default_leave_types(bigint) to authenticated;
