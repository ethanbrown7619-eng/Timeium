-- 106_receives_overtime_default_false.sql
-- Majority of staff don't accrue overtime, so the column default flips to
-- false. Existing rows keep whatever value they already had — this only
-- changes the default for newly-inserted rows.
--
-- Also extends create_employee() to accept p_receives_overtime so the
-- staff-add dialog can pass the checkbox value through cleanly instead of
-- relying on the column default.

alter table public.users
    alter column receives_overtime set default false;

create or replace function public.create_employee(
    p_org_id                   bigint  default null,
    p_name                     text    default null,
    p_email                    text    default null,
    p_department_id            bigint  default null,
    p_cost_rate                numeric default null,
    p_sell_rate                numeric default null,
    p_employment_type          text    default 'waged',
    p_employee_code            text    default null,
    p_overtime_threshold_hours numeric default null,
    p_receives_overtime        boolean default false
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
        overtime_threshold_hours, receives_overtime, qr_token, active
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
        coalesce(p_receives_overtime, false),
        encode(gen_random_bytes(16), 'hex'),
        true
    )
    returning * into v_user;

    return v_user;
end$$;

grant execute on function public.create_employee(
    bigint, text, text, bigint, numeric, numeric, text, text, numeric, boolean
) to authenticated;
