-- 036_login_and_leave.sql
-- Adds:
--   users.must_change_password   — forces password change on first login
--   jobs.is_leave                — marks a job as leave (for leave report & future balances)
--   provision_employee_login()   — creates a Supabase auth account with default password
--
-- Safe to re-run.

create extension if not exists pgcrypto;

--------------------------------------------------------------------------------
-- users.must_change_password
--------------------------------------------------------------------------------

alter table public.users
    add column if not exists must_change_password boolean not null default false;

--------------------------------------------------------------------------------
-- jobs.is_leave
--------------------------------------------------------------------------------

alter table public.jobs
    add column if not exists is_leave boolean not null default false;

--------------------------------------------------------------------------------
-- provision_employee_login
--
-- Given a public.users row id, creates (or re-uses) a Supabase auth.users
-- account with password "PASSWORD", confirms the email, and links the
-- auth account to the public.users row.
--
-- SECURITY DEFINER so it can write to the auth schema.
-- Must be called by an admin (enforced via resolve_org_id in the caller).
--------------------------------------------------------------------------------

create or replace function public.provision_employee_login(p_user_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_email text;
    v_existing_uid uuid;
    v_uid uuid;
begin
    select email, auth_user_id
      into v_email, v_existing_uid
      from public.users
     where id = p_user_id;

    if v_email is null or trim(v_email) = '' then
        raise exception 'Employee has no email address';
    end if;

    -- Already linked to an auth account — nothing to do
    if v_existing_uid is not null then
        return;
    end if;

    -- Check if an auth user already exists for this email
    select id into v_uid
      from auth.users
     where lower(email) = lower(v_email);

    if v_uid is null then
        v_uid := gen_random_uuid();

        insert into auth.users (
            instance_id, id, aud, role, email,
            encrypted_password, email_confirmed_at,
            created_at, updated_at,
            raw_app_meta_data, raw_user_meta_data,
            is_super_admin
        ) values (
            '00000000-0000-0000-0000-000000000000'::uuid,
            v_uid,
            'authenticated',
            'authenticated',
            lower(trim(v_email)),
            crypt('PASSWORD', gen_salt('bf')),
            now(),
            now(), now(),
            '{"provider":"email","providers":["email"]}'::jsonb,
            '{}'::jsonb,
            false
        );

        insert into auth.identities (
            id, user_id, provider_id, identity_data,
            provider, last_sign_in_at, created_at, updated_at
        ) values (
            v_uid::text, v_uid, lower(trim(v_email)),
            jsonb_build_object('sub', v_uid::text, 'email', lower(trim(v_email))),
            'email', now(), now(), now()
        );
    end if;

    -- Link auth user to employee and flag for password change
    update public.users
       set auth_user_id = v_uid,
           must_change_password = true
     where id = p_user_id;
end;
$$;

grant execute on function public.provision_employee_login(bigint) to authenticated;
