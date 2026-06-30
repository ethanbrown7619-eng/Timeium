-- 140_random_temp_passwords.sql
-- Audit finding H1: provisioning and password-reset both set the literal
-- shared password 'PASSWORD', and must_change_password was enforced only
-- client-side (signin.js redirect) — so any freshly provisioned/reset
-- account was takeover-able with a known password by authenticating
-- directly against /auth/v1/token before the user logged in.
--
-- Fix: generate a RANDOM one-time password per user and return it to the
-- admin (to pass to the employee out-of-band). With no shared known
-- credential there's nothing to pre-authenticate with. must_change_password
-- is still set so the user is prompted to choose their own on first login.
--
-- Server-side enforcement of must_change_password (RLS gating until the
-- flag clears) and a binding lockout via a Before-Sign-In auth hook are
-- recommended defence-in-depth follow-ups, but the random password closes
-- the actual takeover vector on its own.
--
-- Safe to re-run.

-- Readable 12-char random password (base64 of 9 random bytes, with the
-- three base64 specials swapped for letters so it's easy to dictate).
create or replace function public.gen_temp_password()
returns text
language sql volatile security definer set search_path = public, extensions
as $$
  select translate(encode(extensions.gen_random_bytes(9), 'base64'), '+/=', 'xyz');
$$;

revoke all on function public.gen_temp_password() from public;

-- provision_employee_login → returns the generated temp password, or
-- null if the account already existed (no password change made).
drop function if exists public.provision_employee_login(bigint);

create or replace function public.provision_employee_login(p_user_id bigint)
returns text
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_email text; v_existing_uid uuid; v_uid uuid; v_target_org bigint; v_pw text;
begin
    select email, auth_user_id, organisation_id into v_email, v_existing_uid, v_target_org
      from public.users where id = p_user_id;
    if v_target_org is null or not public.is_admin_of(v_target_org) then raise exception 'Not authorised'; end if;
    if v_email is null or trim(v_email) = '' then raise exception 'Employee has no email address'; end if;
    if v_existing_uid is not null then return null; end if;

    select id into v_uid from auth.users where lower(email) = lower(v_email);
    if v_uid is null then
        v_pw := public.gen_temp_password();
        v_uid := gen_random_uuid();
        insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
            created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin,
            confirmation_token, recovery_token, email_change_token_new, email_change,
            phone_change, phone_change_token, email_change_token_current, reauthentication_token)
        values ('00000000-0000-0000-0000-000000000000'::uuid, v_uid, 'authenticated', 'authenticated',
            lower(trim(v_email)), extensions.crypt(v_pw, extensions.gen_salt('bf')), now(), now(), now(),
            '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false, '', '', '', '', '', '', '', '');
        insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
        values (v_uid, v_uid, lower(trim(v_email)),
            jsonb_build_object('sub', v_uid::text, 'email', lower(trim(v_email))), 'email', now(), now(), now());
    end if;
    update public.users set auth_user_id = v_uid, must_change_password = true where id = p_user_id;
    return v_pw;  -- null when an existing auth user was linked
end$$;

revoke all on function public.provision_employee_login(bigint) from public;
grant execute on function public.provision_employee_login(bigint) to authenticated;

-- reset_employee_password → returns the generated temp password.
drop function if exists public.reset_employee_password(bigint);

create or replace function public.reset_employee_password(p_user_id bigint)
returns text
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_org bigint; v_auth_uid uuid; v_pw text;
begin
    select organisation_id, auth_user_id into v_org, v_auth_uid from public.users where id = p_user_id;
    if v_org is null then raise exception 'User not found'; end if;
    if not public.is_admin_of(v_org) then raise exception 'Not authorised'; end if;
    if v_auth_uid is null then raise exception 'Employee has no login account yet - use Provision login first'; end if;

    v_pw := public.gen_temp_password();
    update auth.users set encrypted_password = extensions.crypt(v_pw, extensions.gen_salt('bf')), updated_at = now()
        where id = v_auth_uid;
    update public.users set must_change_password = true where id = p_user_id;
    return v_pw;
end$$;

revoke all on function public.reset_employee_password(bigint) from public;
grant execute on function public.reset_employee_password(bigint) to authenticated;
