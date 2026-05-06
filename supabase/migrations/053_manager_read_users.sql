-- 053_manager_read_users.sql
-- Allow managers (and admins/developers) to read user rows in their
-- organisation so the manager dashboard can list team members.
--
-- The pre-existing "employees read own row" policy (049) only returns the
-- caller's own row. Managers loading /department.html therefore saw 0/0 in
-- the donut chart even when their department had members.
--
-- The codebase has two separate "manager" concepts:
--
--   1. admins.role = 'manager'    — org-level admin manager role.
--      Detected by the existing public.is_manager_of(org_id) helper from
--      migration 022.
--
--   2. users.is_manager = true     — department-lead flag, set in staff.html.
--      The /department.html page uses THIS flag to decide whether to render
--      the manager dashboard (see public/js/department.js:31). This concept
--      did not previously have an RLS-level helper.
--
-- We add policies for both, so a user identified as a manager by either
-- mechanism can read user rows in their org. We need a SECURITY DEFINER
-- helper for case (2) because a policy on public.users cannot reference
-- public.users directly without infinite recursion.

create or replace function public.user_is_dept_manager_in_org(p_org_id bigint)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.users
    where auth_user_id    = auth.uid()
      and is_manager      = true
      and organisation_id = p_org_id
  );
$$;

grant execute on function public.user_is_dept_manager_in_org(bigint) to authenticated;

-- Policy keyed on admins.role = 'manager' (covers org admin managers).
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'users'
      and policyname = 'managers read org users'
  ) then
    execute $policy$
      create policy "managers read org users"
        on public.users
        for select
        using (public.is_manager_of(organisation_id))
    $policy$;
  end if;
end$$;

-- Policy keyed on users.is_manager flag (covers department leads without an
-- admins row, which is how staff.html assigns managers).
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'users'
      and policyname = 'dept managers read org users'
  ) then
    execute $policy$
      create policy "dept managers read org users"
        on public.users
        for select
        using (public.user_is_dept_manager_in_org(organisation_id))
    $policy$;
  end if;
end$$;
