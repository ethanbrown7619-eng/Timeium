-- 142_password_verification_hook.sql
-- Audit H1/M3 follow-up: make the account lockout BINDING instead of
-- advisory. Until now check_login_locked was only consulted client-side
-- (signin.js), so an attacker hitting /auth/v1/token directly bypassed
-- it, and login_attempts was populated from a forgeable anon RPC.
--
-- This adds a Supabase "Password Verification Attempt" auth hook. Supabase
-- invokes it inside the auth server on every password check, so:
--   * it is the AUTHORITATIVE recorder of attempts (the client can't
--     forge them — only the auth server calls this), which fully closes
--     the M3 poisoning vector; and
--   * it can REJECT the sign-in when the account is locked, making the
--     lockout real even against direct /auth/v1/token calls.
--
-- Policy: 5+ failed verifications for an email in the last 15 minutes
-- blocks further sign-in (even with a correct password) until the window
-- clears — same threshold the advisory check used.
--
-- ENABLE IT (one-time, dashboard): Authentication > Hooks >
-- "Password Verification Attempt" > enable, point at
-- public.password_verification_hook. Until enabled, no lockout is
-- enforced (same as the prior advisory state).
--
-- Safe to re-run.

create or replace function public.password_verification_hook(event jsonb)
returns jsonb
language plpgsql security definer set search_path = public, auth, extensions
as $$
declare
    v_uid        uuid;
    v_valid      boolean;
    v_email      text;
    v_fail_count integer;
begin
    v_uid   := nullif(event->>'user_id', '')::uuid;
    v_valid := coalesce((event->>'valid')::boolean, false);
    if v_uid is null then
        return jsonb_build_object('decision', 'continue');
    end if;

    select email into v_email from auth.users where id = v_uid;
    if v_email is null then
        return jsonb_build_object('decision', 'continue');
    end if;

    -- Authoritative record of this verification outcome.
    insert into public.login_attempts (email, succeeded, failure_reason)
    values (lower(v_email), v_valid,
            case when v_valid then null else 'password_verification' end);

    -- Count recent failures. A correct password during an active lockout
    -- is still rejected until the 15-minute window clears.
    select count(*) into v_fail_count
      from public.login_attempts
     where email = lower(v_email)
       and succeeded = false
       and attempted_at > now() - interval '15 minutes';

    if v_fail_count >= 5 then
        return jsonb_build_object(
            'decision', 'reject',
            'message',  'Too many failed sign-in attempts. Please wait 15 minutes and try again.'
        );
    end if;

    return jsonb_build_object('decision', 'continue');
end$$;

-- The auth server runs hooks as supabase_auth_admin; it only needs EXECUTE
-- (the function body runs SECURITY DEFINER as the owner). Keep it off every
-- other role.
revoke execute on function public.password_verification_hook(jsonb) from authenticated, anon, public;
grant execute on function public.password_verification_hook(jsonb) to supabase_auth_admin;
