-- 112_xero_connections.sql
-- Xero Payroll NZ integration — phase 1: connection storage + mapping columns.
--
-- One Xero org per organisation. Tokens live server-side and are read by
-- the Cloudflare Worker using the service role (bypassing RLS). Admins
-- see metadata (tenant name, last refresh, errors) via xero_connection_status()
-- which strips tokens.
--
-- Mapping columns added here so phase 2 (admin mapping UI) doesn't need a
-- second migration. Columns are nullable until an admin maps them.
--
-- Safe to re-run.

--------------------------------------------------------------------------------
-- xero_connections
--   access_token:     ~30 minute lifespan, refreshed lazily by the Worker
--   refresh_token:    60-day rolling window, rotates on every refresh — the
--                     Worker must persist the new value immediately after
--                     each /connect/token call or the connection breaks.
--   tenant_id:        the Xero org GUID, passed as Xero-Tenant-Id on every
--                     API call.
--   last_error:       cleared on successful refresh; surfaced in admin UI.
--------------------------------------------------------------------------------

create table if not exists public.xero_connections (
    id                bigserial primary key,
    organisation_id   bigint not null unique
                          references public.organisations (id) on delete cascade,
    tenant_id         text   not null,
    tenant_name       text,
    access_token      text   not null,
    refresh_token     text   not null,
    token_expires_at  timestamptz not null,
    scopes            text   not null,
    connected_by      bigint references public.users (id) on delete set null,
    connected_at      timestamptz not null default now(),
    last_refreshed_at timestamptz,
    last_error        text,
    last_error_at     timestamptz,
    updated_at        timestamptz not null default now()
);

create index if not exists xero_connections_org_idx
    on public.xero_connections (organisation_id);

alter table public.xero_connections enable row level security;

-- Deny everything to regular users — tokens are sensitive. The Worker uses
-- the service role to read/write this table directly; admins read sanitised
-- metadata via xero_connection_status() below.
drop policy if exists "deny all to authenticated" on public.xero_connections;
create policy "deny all to authenticated"
    on public.xero_connections for all
    to authenticated
    using (false)
    with check (false);

--------------------------------------------------------------------------------
-- xero_connection_status(p_org_id)
--   Admin-only metadata read. Returns nothing if not connected, one row
--   otherwise. Token columns are deliberately not exposed.
--------------------------------------------------------------------------------

create or replace function public.xero_connection_status(p_org_id bigint)
returns table (
    tenant_id         text,
    tenant_name       text,
    connected_by_name text,
    connected_at      timestamptz,
    last_refreshed_at timestamptz,
    last_error        text,
    last_error_at     timestamptz,
    scopes            text
)
language plpgsql security definer set search_path = public
as $$
begin
    if not public.is_admin_of(p_org_id) then
        raise exception 'Not authorised';
    end if;
    return query
    select c.tenant_id, c.tenant_name, u.name,
           c.connected_at, c.last_refreshed_at,
           c.last_error, c.last_error_at, c.scopes
      from public.xero_connections c
      left join public.users u on u.id = c.connected_by
     where c.organisation_id = p_org_id;
end$$;

grant execute on function public.xero_connection_status(bigint) to authenticated;

--------------------------------------------------------------------------------
-- xero_disconnect(p_org_id)
--   Admin-only. Hard delete — refresh tokens can't be revoked client-side
--   safely, so the Worker should call POST /connect/revocation before
--   invoking this RPC. Either way, dropping the row is the source-of-truth
--   "we're disconnected" signal.
--------------------------------------------------------------------------------

create or replace function public.xero_disconnect(p_org_id bigint)
returns void
language plpgsql security definer set search_path = public
as $$
begin
    if not public.is_admin_of(p_org_id) then
        raise exception 'Not authorised';
    end if;
    delete from public.xero_connections where organisation_id = p_org_id;
end$$;

grant execute on function public.xero_disconnect(bigint) to authenticated;

--------------------------------------------------------------------------------
-- Mapping columns — populated by the admin mapping UI in phase 2.
--------------------------------------------------------------------------------

alter table public.users
    add column if not exists xero_employee_id text;

create index if not exists users_xero_employee_idx
    on public.users (xero_employee_id)
    where xero_employee_id is not null;

alter table public.leave_types
    add column if not exists xero_leave_type_id text;

create index if not exists leave_types_xero_idx
    on public.leave_types (xero_leave_type_id)
    where xero_leave_type_id is not null;

-- leave_requests.xero_leave_id — populated by approve_leave_request() in
-- phase 3 once the Xero POST succeeds. Null = not yet filed to Xero (or
-- request was rejected/cancelled before reaching Xero).
alter table public.leave_requests
    add column if not exists xero_leave_id text;

create index if not exists leave_requests_xero_idx
    on public.leave_requests (xero_leave_id)
    where xero_leave_id is not null;
