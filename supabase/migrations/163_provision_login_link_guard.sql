-- 163_provision_login_link_guard.sql
-- Security audit 2026-08, finding A9 (Low): provision_employee_login
-- checks that the caller is an admin of the EMPLOYEE ROW's organisation,
-- then looks up auth.users by email address and links whatever it finds:
--
--     select id into v_uid from auth.users where lower(email) = lower(v_email);
--     ...
--     update public.users set auth_user_id = v_uid, ... where id = p_user_id;
--
-- Nothing checks whether that auth identity already belongs to someone
-- else. An admin of org A can create an employee row carrying a known
-- email address belonging to a user of org B and call this, binding org
-- B's identity to an org A employee row.
--
-- The direct impact is modest — org A learns nothing about org B, and it
-- takes admin rights to attempt — but public.users.auth_user_id is the
-- column half the RLS policies join on (`auth_user_id = auth.uid()`), and
-- one auth identity matching two users rows is a state those policies were
-- never designed for. It also breaks getUserContext(), which does a
-- .maybeSingle() on that lookup and errors outright when two rows match.
--
-- Fix: refuse to link an auth identity that is already claimed by a
-- different public.users row, and — where the data allows it — enforce
-- that invariant with a unique index so no future code path can violate it.
--
-- Body is otherwise migration 140's (random temp password); only the guard
-- is new.
--
-- Safe to re-run.

-- Drop first, as migration 140 did: this function returned `void` up to
-- 055 and `text` from 140 onward. CREATE OR REPLACE cannot change a
-- return type, so without the drop this migration would fail outright on
-- any database where 140 was never applied. The grants are re-issued
-- below, so dropping costs nothing.
drop function if exists public.provision_employee_login(bigint);

create or replace function public.provision_employee_login(p_user_id bigint)
returns text
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_email text; v_existing_uid uuid; v_uid uuid; v_target_org bigint; v_pw text;
    v_claimed_by bigint;
begin
    select email, auth_user_id, organisation_id into v_email, v_existing_uid, v_target_org
      from public.users where id = p_user_id;
    if v_target_org is null or not public.is_admin_of(v_target_org) then raise exception 'Not authorised'; end if;
    if v_email is null or trim(v_email) = '' then raise exception 'Employee has no email address'; end if;
    if v_existing_uid is not null then return null; end if;

    select id into v_uid from auth.users where lower(email) = lower(v_email);

    -- A9 guard: never attach an auth identity that another employee row
    -- already owns — in this organisation or any other.
    if v_uid is not null then
        select u.id into v_claimed_by
          from public.users u
         where u.auth_user_id = v_uid
           and u.id <> p_user_id
         limit 1;
        if v_claimed_by is not null then
            raise exception
                'That email already has a login linked to employee record % — it cannot be linked to a second employee',
                v_claimed_by;
        end if;
    end if;

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

--------------------------------------------------------------------------------
-- Enforce the invariant in the schema where the existing data allows it.
--
-- Skipped with a warning (rather than failing the migration) if duplicates
-- already exist — resolve them, then re-run this file to get the index.
--------------------------------------------------------------------------------

do $$
declare v_dupes integer;
begin
    select count(*) into v_dupes from (
        select auth_user_id
          from public.users
         where auth_user_id is not null
         group by auth_user_id
        having count(*) > 1
    ) d;

    if v_dupes > 0 then
        raise warning
            'users.auth_user_id has % duplicated value(s) — unique index NOT created. '
            'Resolve with the audit query in this migration, then re-run it.', v_dupes;
    else
        create unique index if not exists users_auth_user_id_uniq
            on public.users (auth_user_id)
         where auth_user_id is not null;
    end if;
end$$;

--------------------------------------------------------------------------------
-- VERIFICATION / audit query
--
-- 1. Are there existing cross-linked rows? Expect zero:
--
--      select auth_user_id, count(*) as rows,
--             array_agg(id)              as user_ids,
--             array_agg(organisation_id) as orgs
--        from public.users
--       where auth_user_id is not null
--       group by auth_user_id
--      having count(*) > 1;
--
-- 2. Confirm the index exists (it will be absent if step 1 returned rows):
--
--      select indexname from pg_indexes
--       where schemaname = 'public' and indexname = 'users_auth_user_id_uniq';
--
-- 3. Functional check: as an admin, add an employee whose email matches an
--    existing login and click "Provision login". Expect the error
--    'That email already has a login linked to employee record …' rather
--    than a silent re-link. Provisioning a genuinely new email must still
--    return a 12-character temp password.
--------------------------------------------------------------------------------
