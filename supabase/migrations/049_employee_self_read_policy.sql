-- 049_employee_self_read_policy.sql
-- Allow authenticated users to read their own row from public.users.
-- Attendium's existing RLS policies only grant access to admins/developers,
-- so regular employees cannot load their own profile, causing the timesheet
-- page to redirect them to the welcome page.

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'users'
      and policyname = 'employees read own row'
  ) then
    execute $policy$
      create policy "employees read own row"
        on public.users
        for select
        using (auth_user_id = auth.uid())
    $policy$;
  end if;
end$$;
