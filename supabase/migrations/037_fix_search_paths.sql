-- 037_fix_search_paths.sql
-- Fix SECURITY DEFINER functions whose search_path excluded the extensions
-- schema, causing gen_random_bytes / crypt / gen_salt to not be found.
--
-- Safe to re-run.

-- Fix create_employee: add extensions to search_path
create or replace function public.create_employee(
    p_org_id                   bigint  default null,
    p_name                     text    default null,
    p_email                    text    default null,
    p_department_id            bigint  default null,
    p_cost_rate                numeric default null,
    p_sell_rate                numeric default null,
    p_employment_type          text    default 'waged',
    p_employee_code            text    default null,
    p_overtime_threshold_hours numeric default null
)
returns public.users
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_org  bigint;
    v_user public.users;
begin
    v_org := public.resolve_org_id(p_org_id);

    if p_name is null or trim(p_name) = '' then
        raise exception 'Name is required';
    end if;

    if p_employment_type is not null
       and p_employment_type not in ('waged', 'salaried', 'contractor') then
        raise exception 'employment_type must be one of: waged, salaried, contractor';
    end if;

    insert into public.users (
        organisation_id, name, email, department_id,
        cost_rate, sell_rate, employment_type, employee_code,
        overtime_threshold_hours, qr_token, active
    )
    values (
        v_org,
        trim(p_name),
        nullif(trim(coalesce(p_email, '')), ''),
        p_department_id,
        p_cost_rate,
        p_sell_rate,
        coalesce(p_employment_type, 'waged'),
        nullif(trim(coalesce(p_employee_code, '')), ''),
        coalesce(p_overtime_threshold_hours, 40.0),
        encode(gen_random_bytes(16), 'hex'),
        true
    )
    returning * into v_user;

    return v_user;
end$$;

grant execute on function public.create_employee(
    bigint, text, text, bigint, numeric, numeric, text, text, numeric
) to authenticated;

-- Fix provision_employee_login: add extensions to search_path
create or replace function public.provision_employee_login(p_user_id bigint)
returns void
language plpgsql
security definer
set search_path = public, extensions
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

    if v_existing_uid is not null then
        return;
    end if;

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
            is_super_admin,
            confirmation_token, recovery_token,
            email_change_token_new, email_change,
            phone_change, phone_change_token,
            email_change_token_current, reauthentication_token
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
            false,
            '', '', '', '', '', '', '', ''
        );

        insert into auth.identities (
            id, user_id, provider_id, identity_data,
            provider, last_sign_in_at, created_at, updated_at
        ) values (
            v_uid, v_uid, lower(trim(v_email)),
            jsonb_build_object('sub', v_uid::text, 'email', lower(trim(v_email))),
            'email', now(), now(), now()
        );
    end if;

    update public.users
       set auth_user_id = v_uid,
           must_change_password = true
     where id = p_user_id;
end;
$$;

grant execute on function public.provision_employee_login(bigint) to authenticated;
