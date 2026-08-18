-- 176_no_password_prompt_for_microsoft.sql
--
-- Somebody whose first-ever sign-in is with Microsoft should never be asked
-- to set a password. They will never use one.
--
--------------------------------------------------------------------------------
-- WHY THEY WERE BEING ASKED
--------------------------------------------------------------------------------
-- Admin-created employees are provisioned with a random temp password and
-- `users.must_change_password = true` (migrations 140 / 163). That flag exists
-- to stop somebody DECLINING to replace an admin-issued credential, and
-- shared.js enforces it on every page that resolves a user context.
--
-- An Entra user has no such credential to replace. Migration 172 goes further
-- and makes the password INERT for them: once an account has an `azure`
-- identity, the Password Verification hook rejects it outright. So the prompt
-- was asking them to choose a secret the auth server would then refuse.
--
-- shared.js already tried to exempt them, keyed on
-- `session.user.app_metadata.provider !== 'email'`. That heuristic reads a
-- claim GoTrue stamps when the account is CREATED, not one it rewrites per
-- sign-in — and every account here is created with an email identity by an
-- admin before Microsoft is ever linked. This migration replaces the heuristic
-- with the fact in `auth.identities`, which holds regardless of what the JWT
-- claims. The client keeps the provider check as a zero-cost fast path; this
-- is the authority.
--
--------------------------------------------------------------------------------
-- WHO IS EXEMPT — KEPT IN LOCKSTEP WITH 172
--------------------------------------------------------------------------------
-- Exempt iff the account has an `azure` identity AND is not role 'developer'.
-- That is 172's rejection condition, character for character, and the two must
-- stay identical: you are excused from being asked for a password exactly when
-- a password can no longer get you in. A developer keeps the break-glass
-- password 172 preserves for them, so they keep the obligation to set one.
--
--------------------------------------------------------------------------------
-- IS THIS SAFE WITH THE AUTH HOOK OFF?
--------------------------------------------------------------------------------
-- Yes. 172 (and 142 before it) do nothing until the "Password Verification
-- Attempt" hook is enabled in the dashboard, and signin.js records that it is
-- not currently on. Clearing the flag anyway leaves no attacker-known
-- credential live: since migration 140 the temp password is random and
-- delivered out of band. The flag's job is consent, not secrecy.
--
-- What we do NOT do is delete the email identity or scramble the password.
-- Leaving it dormant is what keeps an un-linking recoverable.
--
-- Safe to re-run.


--------------------------------------------------------------------------------
-- settle_microsoft_signin — called by the client when it sees the flag set
--
-- One function, not a predicate plus a mutator: nothing else needs to ask the
-- question, and splitting it would cost the client a second round trip in the
-- only case that reaches it.
--
-- Returns true when the caller is (now) exempt, false otherwise. Never raises:
-- it is called from the user-context fetch that every page runs, and that must
-- not be breakable by this.
--------------------------------------------------------------------------------
create or replace function public.settle_microsoft_signin()
returns boolean
language plpgsql volatile security definer set search_path = public, auth, pg_temp
as $$
declare
    v_uid    uuid;
    v_linked boolean;
    v_exempt boolean;
begin
    v_uid := auth.uid();
    if v_uid is null then
        return false;
    end if;

    -- Provider is 'azure' — the name Supabase uses for Entra, confirmed
    -- against a real linked row during the 2026-08 linking spike rather than
    -- assumed. Same predicate 172's hook uses.
    select exists (
        select 1 from auth.identities i
         where i.user_id = v_uid and i.provider = 'azure'
    ) into v_linked;

    if not v_linked then
        return false;
    end if;

    -- Break-glass, developer role only — see 172. Admins and managers are NOT
    -- included.
    select exists (
        select 1 from public.admins a
         where a.user_id = v_uid and a.role = 'developer'
    ) into v_exempt;

    if v_exempt then
        return false;
    end if;

    -- Cleared rather than merely ignored, so the flag stops asserting
    -- something untrue about the account and every future page load is a
    -- plain cache read with no extra call.
    update public.users
       set must_change_password = false
     where auth_user_id = v_uid
       and must_change_password;

    return true;
exception
    when others then
        return false;
end$$;

revoke all on function public.settle_microsoft_signin() from public, anon;
grant execute on function public.settle_microsoft_signin() to authenticated;

notify pgrst, 'reload schema';


--------------------------------------------------------------------------------
-- WHO DOES THIS AFFECT RIGHT NOW?
--------------------------------------------------------------------------------
-- Read-only. Run it before applying to see who stops being prompted. Expect
-- the linked, non-developer, still-flagged rows to be the ones that change.
--
--   select u.name, u.email, u.must_change_password,
--          exists (select 1 from auth.identities i
--                   where i.user_id = au.id and i.provider = 'azure')  as linked,
--          exists (select 1 from public.admins a
--                   where a.user_id = au.id
--                     and a.role = 'developer')                        as developer
--     from public.users u
--     join auth.users au on au.id = u.auth_user_id
--    where u.active
--    order by u.must_change_password desc, u.name;


--------------------------------------------------------------------------------
-- VERIFICATION
--------------------------------------------------------------------------------
-- 1. As a linked, non-developer employee with the flag set:
--      select public.settle_microsoft_signin();     -- expect true
--      select must_change_password from public.users where auth_user_id = auth.uid();
--                                                   -- expect false
-- 2. As a developer (linked or not):
--      select public.settle_microsoft_signin();     -- expect false, flag untouched
-- 3. As a password-only employee:
--      select public.settle_microsoft_signin();     -- expect false, flag untouched
--
-- Running it twice is a no-op — the UPDATE is already filtered on the flag.


--------------------------------------------------------------------------------
-- DELIBERATELY NOT DONE HERE
--------------------------------------------------------------------------------
-- The flag is not cleared by a trigger on auth.identities. Owning a trigger on
-- an auth-schema table means Supabase's own migrations run over it, and the
-- lazy clear costs one RPC once per affected employee, ever.
--
-- Provisioning still sets must_change_password = true for everyone (140/163).
-- It has to: nothing at create time knows whether the person will ever link
-- Microsoft. This migration is the correction on first contact, which is the
-- earliest moment the answer exists.
