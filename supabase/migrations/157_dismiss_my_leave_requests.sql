-- 157_dismiss_my_leave_requests.sql
-- Lets an employee DISMISS their own finished (rejected or cancelled)
-- leave requests so they stop cluttering the My Requests list. This is
-- a per-employee display flag, not a delete: the row is untouched apart
-- from a timestamp, and admin views (which don't filter on it) still
-- show the full history.
--
-- leave_requests has no self-UPDATE RLS policy, so the flag is set via
-- a SECURITY DEFINER RPC with an ownership check.
--
-- Safe to re-run.

alter table public.leave_requests
    add column if not exists dismissed_at timestamptz;

create or replace function public.dismiss_my_leave_request(p_request_id bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    v_req public.leave_requests;
    v_me  bigint;
begin
    select lr.* into v_req from public.leave_requests lr where lr.id = p_request_id;
    if v_req.id is null then
        raise exception 'Leave request not found';
    end if;

    select u.id into v_me
      from public.users u
     where u.auth_user_id = auth.uid()
       and u.organisation_id = v_req.organisation_id
     limit 1;
    if v_me is null or v_me <> v_req.user_id then
        raise exception 'You can only dismiss your own requests';
    end if;
    if v_req.status not in ('rejected', 'cancelled') then
        raise exception 'Only rejected or cancelled requests can be dismissed (current: %)', v_req.status;
    end if;

    update public.leave_requests
       set dismissed_at = now(),
           updated_at = now()
     where id = p_request_id;
end$$;

grant execute on function public.dismiss_my_leave_request(bigint) to authenticated;
