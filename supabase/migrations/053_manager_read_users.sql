-- 053_manager_read_users.sql
-- Allow managers (and admins/developers) to read user rows in their
-- organisation so the manager dashboard can list team members.
--
-- The pre-existing "employees read own row" policy (049) only returns the
-- caller's own row. Managers loading /department.html therefore saw 0/0 in
-- the donut chart even when their department had members.
--
-- public.is_manager_of(org_id) is a SECURITY DEFINER helper from migration
-- 022 that returns true for developers, org admins, and org managers.

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
