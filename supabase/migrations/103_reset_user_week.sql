-- 103_reset_user_week.sql
-- Developer-only helper to wipe a single employee's timesheet (and its
-- entries) for one week. Used from the staff edit dialog when a
-- developer needs to undo a submission/approval that can't be reverted
-- through the normal manager/admin UI.
--
-- Gated on public.is_developer() because the action bypasses the
-- approval workflow entirely; admins should be using the standard
-- reject/edit flow.

create or replace function public.reset_user_week(
    p_user_id    bigint,
    p_week_start date
)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
    v_count integer;
begin
    if not public.is_developer() then
        raise exception 'Not authorised';
    end if;

    delete from public.timesheet_entries
     where timesheet_id in (
        select id from public.timesheets
         where user_id    = p_user_id
           and week_start = p_week_start
     );

    delete from public.timesheets
     where user_id    = p_user_id
       and week_start = p_week_start;
    get diagnostics v_count = row_count;

    return v_count;
end;
$$;

revoke all on function public.reset_user_week(bigint, date) from public;
grant execute on function public.reset_user_week(bigint, date) to authenticated;
