-- 102_manager_approve_timesheets.sql
-- Department managers had a SELECT-only RLS policy on public.timesheets, so
-- their UPDATE { status: 'approved' | 'rejected' } silently matched zero
-- rows. The frontend's concurrency guard then surfaced that as
-- "Already actioned by another manager", confusing managers into thinking
-- the row had moved on when in fact RLS had blocked the write entirely.
--
-- This migration adds an UPDATE policy scoped to the user's managed
-- departments (departments.manager_id = caller's user id). The policy is
-- limited to submitted -> approved/rejected transitions to keep the
-- manager's reach narrow.

create or replace function public.user_manages_target_user(p_user_id bigint)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.users target
    join public.departments d on d.id = target.department_id
    join public.users mgr on mgr.id = d.manager_id
    where target.id = p_user_id
      and mgr.auth_user_id = auth.uid()
  );
$$;

grant execute on function public.user_manages_target_user(bigint) to authenticated;

drop policy if exists "managers update dept timesheets" on public.timesheets;
create policy "managers update dept timesheets"
  on public.timesheets for update
  to authenticated
  using (
    timesheets.status = 'submitted'
    and public.user_manages_target_user(timesheets.user_id)
  )
  with check (
    timesheets.status in ('approved', 'rejected')
    and public.user_manages_target_user(timesheets.user_id)
  );
