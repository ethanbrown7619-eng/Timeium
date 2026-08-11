-- 172_microsoft_only_after_linking.sql
--
-- Once an account has a Microsoft identity linked, stop accepting its
-- password. Otherwise Entra is only a convenience: a leaked password still
-- walks straight past the tenant's MFA and conditional-access policies,
-- because /auth/v1/token never involves Microsoft at all.
--
-- Enforced in the Password Verification Attempt hook (migration 142, body
-- last set by 162) rather than in signin.js. The hook runs INSIDE the auth
-- server, so it also rejects someone posting directly to /auth/v1/token —
-- a client-side check would be decoration.
--
-- BREAK-GLASS: role 'developer' ONLY. This is deliberate and load-bearing.
-- Microsoft sign-in has a single point of failure — the client secret in
-- the Supabase dashboard — and when it lapses or is revoked, EVERY linked
-- account loses its only way in at the same moment. Without an exempt role
-- there is no route back into the app to fix it.
--
-- Admins and managers are NOT exempt: once they link Microsoft they are
-- Microsoft-only like everyone else. Every exempt account is a password
-- that still bypasses Entra, so the exemption is kept to the smallest set
-- that can still repair a broken Entra config — which is the developer
-- role, since fixing it means dashboard access anyway.
--
-- The corollary is worth stating plainly: if the only developer account
-- ever links Microsoft AND the secret lapses, nobody can sign in at all
-- and recovery is through the Supabase dashboard, not the app. Keeping a
-- developer account unlinked is the cheap insurance.
--
-- Contractors are unaffected automatically: they have no Microsoft account,
-- never link, and keep signing in with a password forever.
--
-- ENABLE IT (one-time, dashboard): Authentication > Hooks > "Password
-- Verification Attempt" > enable, pointing at
-- public.password_verification_hook. THIS MIGRATION DOES NOTHING UNTIL
-- THAT IS ON — the same caveat 142 carries, and the same one that makes
-- the account lockout inert too. Worth confirming rather than assuming.
--
-- Safe to re-run.


--------------------------------------------------------------------------------
-- password_verification_hook — body carried forward from 162
--------------------------------------------------------------------------------
-- 162's version is what is actually live (it added the `source` column and
-- scoped the lockout count to source = 'auth_hook'). 142's older body is
-- superseded; do not restore it. The only additions here are the linked-
-- account check and its exclusion from the lockout counter.
create or replace function public.password_verification_hook(event jsonb)
returns jsonb
language plpgsql security definer set search_path = public, auth, extensions
as $$
declare
    v_uid        uuid;
    v_valid      boolean;
    v_email      text;
    v_fail_count integer;
    v_linked     boolean;
    v_exempt     boolean;
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

    -- Has this account linked Microsoft? Provider is 'azure' — the name
    -- Supabase uses for the Entra provider, confirmed against a real
    -- linked row rather than assumed.
    select exists (
        select 1 from auth.identities i
         where i.user_id = v_uid and i.provider = 'azure'
    ) into v_linked;

    -- Break-glass, developer role only. Admins and managers are NOT
    -- included — once they link Microsoft they are Microsoft-only like
    -- everyone else.
    select exists (
        select 1 from public.admins a
         where a.user_id = v_uid and a.role = 'developer'
    ) into v_exempt;

    if v_linked and not v_exempt then
        -- Recorded so the audit trail shows the attempt happened, and
        -- deliberately BEFORE the lockout check below, so a confused user
        -- always gets the useful message rather than being told they have
        -- made too many failed attempts.
        insert into public.login_attempts (email, succeeded, failure_reason, source)
        values (lower(v_email), false, 'microsoft_required', 'auth_hook');

        return jsonb_build_object(
            'decision', 'reject',
            'message',  'This account signs in with Microsoft. Use the "Sign in with Microsoft" button instead of a password.'
        );
    end if;

    insert into public.login_attempts (email, succeeded, failure_reason, source)
    values (lower(v_email), v_valid,
            case when v_valid then null else 'password_verification' end,
            'auth_hook');

    select count(*) into v_fail_count
      from public.login_attempts
     where email        = lower(v_email)
       and succeeded    = false
       and source       = 'auth_hook'
       -- Policy rejections are not credential failures. Without this, a
       -- user whose Microsoft link is later removed could find themselves
       -- locked out for 15 minutes by attempts they made while the block
       -- was in force.
       and failure_reason is distinct from 'microsoft_required'
       and attempted_at > now() - interval '15 minutes';

    if v_fail_count >= 5 then
        return jsonb_build_object(
            'decision', 'reject',
            'message',  'Too many failed sign-in attempts. Please wait 15 minutes and try again.'
        );
    end if;

    return jsonb_build_object('decision', 'continue');
end$$;

revoke execute on function public.password_verification_hook(jsonb) from authenticated, anon, public;
grant execute on function public.password_verification_hook(jsonb) to supabase_auth_admin;


--------------------------------------------------------------------------------
-- Who does this affect right now?
--------------------------------------------------------------------------------
-- Read-only. Run it after applying to see exactly who has just lost
-- password sign-in, before anyone discovers it by being locked out.
--
--   select u.name, u.email,
--          exists (select 1 from auth.identities i
--                   where i.user_id = au.id and i.provider = 'azure')  as linked,
--          exists (select 1 from public.admins a
--                   where a.user_id = au.id
--                     and a.role = 'developer')                        as exempt
--     from public.users u
--     join auth.users au on au.id = u.auth_user_id
--    where u.active
--    order by linked desc, u.name;


--------------------------------------------------------------------------------
-- Deliberately NOT done here
--------------------------------------------------------------------------------
-- Password RESET is not blocked. A linked user can still request a reset
-- email and set a new password — they just can't sign in with it, and this
-- hook tells them why. Blocking the reset request itself would need a
-- separate hook and buys nothing: the password is already inert.
--
-- The sign-in form still shows the password fields to everyone. Hiding
-- them per-account would mean asking the server "is this email linked?"
-- before authentication, which hands an unauthenticated caller a way to
-- enumerate which staff have Microsoft accounts. The rejection message
-- after the fact is the better trade.
