-- 139_login_attempt_hardening.sql
-- Audit finding M3: record_login_attempt was anon-callable and trusted a
-- client-supplied `succeeded` flag + arbitrary email, so anyone could
-- forge success rows (forensic pollution) or write failures to flip the
-- lockout for a victim.
--
-- Fix: the anon endpoint now records FAILURES ONLY (no succeeded param to
-- forge). Successes are recorded by a separate authenticated RPC that
-- derives the email from auth.uid(), so a caller can't fabricate a
-- success for someone else's account.
--
-- The lockout (check_login_locked) only ever counted failures, so this
-- doesn't change its behaviour — it just removes the forgeable success
-- path. Keying the lockout on (email, IP) to fully neutralise the
-- fake-failure DoS needs request-IP plumbing at the edge and is deferred
-- until the binding server-side lockout (auth hook) lands.
--
-- Safe to re-run.

-- Replace the 4-arg (with boolean) signature with a failures-only 3-arg.
drop function if exists public.record_login_attempt(text, boolean, text, text);

create or replace function public.record_login_attempt(
    p_email          text,
    p_failure_reason text default null,
    p_user_agent     text default null
)
returns void
language sql security definer set search_path = public
as $$
  insert into public.login_attempts (email, succeeded, failure_reason, user_agent)
  values (lower(coalesce(p_email, '')), false, p_failure_reason, p_user_agent);
$$;

revoke all on function public.record_login_attempt(text, text, text) from public;
grant execute on function public.record_login_attempt(text, text, text) to anon, authenticated;

-- Success path: authenticated only, email derived server-side from the
-- session so it can't be forged for another account.
create or replace function public.record_login_success()
returns void
language plpgsql security definer set search_path = public
as $$
declare
    v_email text;
begin
    select email into v_email from auth.users where id = auth.uid();
    if v_email is not null then
        insert into public.login_attempts (email, succeeded, failure_reason)
        values (lower(v_email), true, null);
    end if;
end$$;

revoke all on function public.record_login_success() from public;
grant execute on function public.record_login_success() to authenticated;
