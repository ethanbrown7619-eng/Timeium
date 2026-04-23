-- 040_public_holidays.sql
-- Public holidays table for calendar display and future leave calculations.
-- Safe to re-run.

create table if not exists public.public_holidays (
    id              bigserial primary key,
    organisation_id bigint not null references public.organisations (id) on delete cascade,
    holiday_date    date   not null,
    name            text   not null,
    created_at      timestamptz not null default now(),
    unique (organisation_id, holiday_date)
);

create index if not exists public_holidays_org_idx
    on public.public_holidays (organisation_id, holiday_date);

alter table public.public_holidays enable row level security;

drop policy if exists "admins manage holidays" on public.public_holidays;
create policy "admins manage holidays"
    on public.public_holidays for all
    using (public.is_admin_of(organisation_id))
    with check (public.is_admin_of(organisation_id));

drop policy if exists "members read holidays" on public.public_holidays;
create policy "members read holidays"
    on public.public_holidays for select
    using (
        exists (
            select 1 from public.users
            where users.organisation_id = public_holidays.organisation_id
              and users.auth_user_id = auth.uid()
        )
        or public.is_admin_of(organisation_id)
    );
