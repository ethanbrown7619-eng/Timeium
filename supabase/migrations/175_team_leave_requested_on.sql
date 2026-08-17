-- 175_team_leave_requested_on.sql
-- Show reviewers WHEN a leave request was raised.
--
-- The manager queues (Leave → Team, both "waiting on your review" and
-- "awaiting employee acceptance") list who/what/when-for but never when the
-- request arrived, so there's no way to see which ones have been sitting
-- longest — the employee's own My Requests table has shown a submitted
-- timestamp all along. leave_requests.created_at already holds it and
-- list_team_leave_requests already ORDERs by it; it just wasn't returned.
--
--   - list_team_leave_requests: recreated to also return created_at.
--     Appended at the END of the returns table, keeping 155's contract —
--     existing callers are unaffected, and the page renders the cell blank
--     if it's reading an older copy of the function.
--
-- Changing a function's return type needs a DROP first; CREATE OR REPLACE
-- can't widen it. Safe to re-run.

--------------------------------------------------------------------------------
-- list_team_leave_requests — + created_at (appended)
--------------------------------------------------------------------------------

drop function if exists public.list_team_leave_requests(bigint, text);

create or replace function public.list_team_leave_requests(
    p_org_id bigint,
    p_status text
)
returns table (
    id              bigint,
    user_id         bigint,
    employee_name   text,
    leave_type_name text,
    start_date      date,
    end_date        date,
    hours_per_day   numeric,
    skip_weekends   boolean,
    reason          text,
    status          text,
    leave_type_id   bigint,
    requested_by    bigint,
    created_at      timestamptz
)
language plpgsql stable security definer set search_path = public
as $$
begin
    return query
    select lr.id, lr.user_id, u.name, lt.name,
           lr.start_date, lr.end_date, lr.hours_per_day, lr.skip_weekends,
           lr.reason, lr.status, lr.leave_type_id, lr.requested_by,
           lr.created_at
      from public.leave_requests lr
      join public.users u       on u.id = lr.user_id
      left join public.leave_types lt on lt.id = lr.leave_type_id
     where lr.organisation_id = p_org_id
       and lr.status = p_status
       and (public.is_admin_of(p_org_id)
            or public.user_manages_target_user(lr.user_id))
     order by lr.created_at;
end$$;

grant execute on function public.list_team_leave_requests(bigint, text) to authenticated;
