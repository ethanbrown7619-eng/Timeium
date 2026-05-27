-- 111_clear_must_change_password.sql
-- public.users has a self-SELECT policy (049) but no self-UPDATE policy.
-- The change-password / reset-password / settings flows all do
--   sb.from("users").update({ must_change_password: false })
-- after auth.updateUser() succeeds. RLS silently rejects the update
-- (0 rows changed, no error), so on the next sign-in must_change_password
-- is still true and signin.html bounces the user back to change-password.html.
--
-- Fix: a SECURITY DEFINER RPC that clears the flag for the calling
-- auth.uid()'s own row. Locked down to that single column so it can't be
-- abused to bump other fields.

create or replace function public.clear_must_change_password()
returns void
language plpgsql security definer set search_path = public
as $$
begin
    update public.users
       set must_change_password = false
     where auth_user_id = auth.uid();
end$$;

revoke all on function public.clear_must_change_password() from public;
grant execute on function public.clear_must_change_password() to authenticated;
