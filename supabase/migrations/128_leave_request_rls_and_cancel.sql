-- 128_leave_request_rls_and_cancel.sql
-- Bridge fixes for the new two-step status enum.
--
-- Migration 126 split 'pending' into 'pending_manager' / 'pending_admin'.
-- The employee-side RLS policies from 042 reference the literal 'pending'
-- and silently become no-ops after the rename — meaning employees can't
-- update or delete their own pending leave requests at all. Redefining
-- them against the new enum.
--
-- Also adds cancel_leave_request RPC — clean UX wrapper that the My
-- Leave page calls instead of direct UPDATE. SECURITY DEFINER so it
-- works regardless of RLS edge cases, with an explicit owner check.
--
-- Safe to re-run.

drop policy if exists "employees insert own pending leave_requests" on public.leave_requests;
drop policy if exists "employees update own pending leave_requests" on public.leave_requests;
drop policy if exists "employees delete own pending leave_requests" on public.leave_requests;

-- Insert: own row, status must land in pending_manager or pending_admin.
-- (In practice the submit_leave_request RPC handles inserts as SECURITY
-- DEFINER, but keep the policy so direct PostgREST inserts still work
-- if anyone wires that path later.)
create policy "employees insert own pending leave_requests"
    on public.leave_requests for insert
    to authenticated
    with check (
        status in ('pending_manager', 'pending_admin')
        and exists (
            select 1 from public.users u
            where u.id = leave_requests.user_id
              and u.auth_user_id = auth.uid()
        )
    );

-- Update: own row, can edit while still pending, can only land in another
-- pending status or 'cancelled'. Direct flips to approved/rejected are
-- blocked here so an employee can't approve their own leave by writing
-- to PostgREST directly.
create policy "employees update own pending leave_requests"
    on public.leave_requests for update
    to authenticated
    using (
        status in ('pending_manager', 'pending_admin')
        and exists (
            select 1 from public.users u
            where u.id = leave_requests.user_id
              and u.auth_user_id = auth.uid()
        )
    )
    with check (
        status in ('pending_manager', 'pending_admin', 'cancelled')
        and exists (
            select 1 from public.users u
            where u.id = leave_requests.user_id
              and u.auth_user_id = auth.uid()
        )
    );

-- Delete: own row while still pending.
create policy "employees delete own pending leave_requests"
    on public.leave_requests for delete
    to authenticated
    using (
        status in ('pending_manager', 'pending_admin')
        and exists (
            select 1 from public.users u
            where u.id = leave_requests.user_id
              and u.auth_user_id = auth.uid()
        )
    );

create or replace function public.cancel_leave_request(p_request_id bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    v_req     public.leave_requests;
    v_user_id bigint;
begin
    select lr.* into v_req from public.leave_requests lr where lr.id = p_request_id;
    if v_req.id is null then
        raise exception 'Leave request not found';
    end if;
    if v_req.status not in ('pending_manager', 'pending_admin') then
        raise exception 'Only pending requests can be cancelled (current: %)', v_req.status;
    end if;

    select u.id into v_user_id
      from public.users u
     where u.auth_user_id = auth.uid()
     limit 1;
    if v_user_id is null or v_user_id <> v_req.user_id then
        raise exception 'Not authorised — you can only cancel your own requests';
    end if;

    update public.leave_requests
       set status     = 'cancelled',
           updated_at = now()
     where id = p_request_id;
end$$;

grant execute on function public.cancel_leave_request(bigint) to authenticated;
