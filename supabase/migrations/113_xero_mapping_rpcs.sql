-- 113_xero_mapping_rpcs.sql
-- Admin-only RPCs that persist the Xero employee / leave-type mappings.
-- Using RPCs (rather than letting the admin UI PATCH users/leave_types
-- directly) lets us keep the mapping writes auditable and gives us a single
-- place to add validation later (e.g. checking the GUID format).
--
-- Safe to re-run.

create or replace function public.xero_set_employee_mapping(
    p_user_id          bigint,
    p_xero_employee_id text
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    v_org_id bigint;
begin
    select organisation_id into v_org_id from public.users where id = p_user_id;
    if v_org_id is null then
        raise exception 'User not found';
    end if;
    if not public.is_admin_of(v_org_id) then
        raise exception 'Not authorised';
    end if;
    update public.users
       set xero_employee_id = nullif(trim(p_xero_employee_id), '')
     where id = p_user_id;
end$$;

grant execute on function public.xero_set_employee_mapping(bigint, text) to authenticated;

create or replace function public.xero_set_leave_type_mapping(
    p_leave_type_id      bigint,
    p_xero_leave_type_id text
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    v_org_id bigint;
begin
    select organisation_id into v_org_id from public.leave_types where id = p_leave_type_id;
    if v_org_id is null then
        raise exception 'Leave type not found';
    end if;
    if not public.is_admin_of(v_org_id) then
        raise exception 'Not authorised';
    end if;
    update public.leave_types
       set xero_leave_type_id = nullif(trim(p_xero_leave_type_id), '')
     where id = p_leave_type_id;
end$$;

grant execute on function public.xero_set_leave_type_mapping(bigint, text) to authenticated;
