-- 104_login_attempts.sql
-- Login audit + soft lockout for the timesheet sign-in page.
--
-- - public.login_attempts stores every signin try (success or failure)
--   keyed by lowercased email. RLS lets developers/org admins read it
--   for forensic review; anon/authenticated can only insert through the
--   record_login_attempt RPC.
-- - record_login_attempt() is callable pre-auth (anon) so the signin
--   form can record both success and failure paths.
-- - check_login_locked() returns true when there have been 5 or more
--   failed attempts on the same email in the last 15 minutes. The
--   signin form calls this before invoking supabase auth so locked
--   accounts get a clear message instead of burning more attempts.
--
-- Notes
-- - This is layered on top of Supabase's built-in rate limits
--   (~30 auth req / 5 min / IP) and bcrypt cost factor — both of
--   which already make brute-force impractical. The lockout adds
--   visibility and a clear "you're locked" UX.
-- - Client-side checks can be bypassed by a determined attacker, but
--   the audit log is server-authoritative and the bcrypt cost remains.
--   For fully server-side enforcement, enable Supabase Auth Hooks
--   (Auth Hooks > Before User Signs In) and gate via this same table.

create table if not exists public.login_attempts (
  id              bigserial primary key,
  email           text,
  succeeded       boolean    not null,
  failure_reason  text,
  user_agent      text,
  attempted_at    timestamptz not null default now()
);

create index if not exists login_attempts_email_idx
  on public.login_attempts (email, attempted_at desc);
create index if not exists login_attempts_attempted_at_idx
  on public.login_attempts (attempted_at desc);

-- Explicit grants for the post-Oct-2026 Data API behaviour.
--
-- - authenticated: SELECT only — required for the "developers read login
--   attempts" RLS policy to be reachable. RLS filters down to is_developer()
--   so non-devs see zero rows even though the grant exists.
-- - service_role: full access for dashboard / SQL editor queries.
-- - anon: no table-level access. anon writes through record_login_attempt,
--   which is a SECURITY DEFINER RPC and bypasses table grants.
grant select on public.login_attempts to authenticated;
grant select, insert, update, delete on public.login_attempts to service_role;

alter table public.login_attempts enable row level security;

drop policy if exists "developers read login attempts" on public.login_attempts;
create policy "developers read login attempts"
  on public.login_attempts for select
  to authenticated
  using (public.is_developer());

-- No direct inserts; everything goes through the RPC.
drop policy if exists "no direct insert login attempts" on public.login_attempts;

create or replace function public.record_login_attempt(
    p_email          text,
    p_succeeded      boolean,
    p_failure_reason text default null,
    p_user_agent     text default null
)
returns void
language sql security definer set search_path = public
as $$
  insert into public.login_attempts (email, succeeded, failure_reason, user_agent)
  values (lower(coalesce(p_email, '')), coalesce(p_succeeded, false), p_failure_reason, p_user_agent);
$$;

revoke all on function public.record_login_attempt(text, boolean, text, text) from public;
grant execute on function public.record_login_attempt(text, boolean, text, text) to anon, authenticated;

create or replace function public.check_login_locked(p_email text)
returns boolean
language sql security definer set search_path = public stable
as $$
  select (
    select count(*)
      from public.login_attempts
     where email        = lower(coalesce(p_email, ''))
       and succeeded    = false
       and attempted_at > now() - interval '15 minutes'
  ) >= 5;
$$;

revoke all on function public.check_login_locked(text) from public;
grant execute on function public.check_login_locked(text) to anon, authenticated;
