-- 058_dev_tools_and_password_reset.sql
--
-- Two admin-callable SECURITY DEFINER helpers:
--
--   1. public.reset_employee_password(p_user_id bigint)
--      - Wipes the auth.users.encrypted_password for the given employee
--        back to the default ('PASSWORD'), sets must_change_password = true.
--      - Same effect as the provision_employee_login default for fresh users.
--      - Gated on is_admin_of() for the employee's organisation.
--
--   2. public.reset_org_hours(p_org_id bigint)
--      - Deletes every timesheet_entry and timesheet row in the org.
--      - Intended for demo cleanup: generate test data, run a demo,
--        reset everything afterwards.
--      - Gated on is_admin_of(). Developers (NULL org admins) also pass
--        via the existing is_admin_of branch.
--      - Returns the count of timesheets that were deleted so the caller
--        can show a confirmation toast.
--
-- Idempotent (create or replace).

create or replace function public.reset_employee_password(p_user_id bigint)
returns void
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_org      bigint;
    v_auth_uid uuid;
begin
    select organisation_id, auth_user_id
      into v_org, v_auth_uid
      from public.users
     where id = p_user_id;

    if v_org is null then
        raise exception 'User not found';
    end if;
    if not public.is_admin_of(v_org) then
        raise exception 'Not authorised';
    end if;
    if v_auth_uid is null then
        raise exception 'Employee has no login account yet - use Provision login first';
    end if;

    update auth.users
       set encrypted_password = extensions.crypt('PASSWORD', extensions.gen_salt('bf')),
           updated_at         = now()
     where id = v_auth_uid;

    update public.users
       set must_change_password = true
     where id = p_user_id;
end;
$$;

revoke all on function public.reset_employee_password(bigint) from public;
grant execute on function public.reset_employee_password(bigint) to authenticated;

create or replace function public.reset_org_hours(p_org_id bigint)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
    v_count integer;
begin
    if not public.is_admin_of(p_org_id) then
        raise exception 'Not authorised';
    end if;

    delete from public.timesheet_entries
     where timesheet_id in (
        select id from public.timesheets where organisation_id = p_org_id
     );

    delete from public.timesheets where organisation_id = p_org_id;
    get diagnostics v_count = row_count;

    return v_count;
end;
$$;

revoke all on function public.reset_org_hours(bigint) from public;
grant execute on function public.reset_org_hours(bigint) to authenticated;
