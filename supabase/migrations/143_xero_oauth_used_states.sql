-- 143_xero_oauth_used_states.sql
-- Audit L5: the Xero OAuth state token carries a nonce but it was never
-- recorded/checked, so a captured state was replayable for its full
-- 600s TTL. This table lets the callback burn the nonce on first use so
-- a replay is rejected.
--
-- service_role only (the Worker writes it); no anon/authenticated grant.
-- Rows are tiny and self-expire in relevance after the 600s state TTL —
-- a periodic cleanup can prune them but isn't required for correctness.
--
-- Safe to re-run.

create table if not exists public.xero_oauth_used_states (
    nonce   text primary key,
    used_at timestamptz not null default now()
);

alter table public.xero_oauth_used_states enable row level security;
revoke all on public.xero_oauth_used_states from anon, authenticated;
grant all on public.xero_oauth_used_states to service_role;
