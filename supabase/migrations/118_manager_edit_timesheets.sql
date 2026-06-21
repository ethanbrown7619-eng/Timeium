-- 118_manager_edit_timesheets.sql
-- Extends timesheet edit capability from admins to managers, scoped to
-- users in the departments they manage.
--
-- Two pieces:
--   1. RLS — new "managers manage dept timesheets" / "managers manage
--      dept entries" policies (FOR ALL), additive to the existing narrow
--      "managers update dept timesheets" (which only allowed submitted →
--      approved/rejected). Managers can now also create, edit hours,
--      delete entries, and flip status freely for users they manage.
--   2. RPC — manager_get_or_create_timesheet mirrors the admin variant
--      (110) but checks user_manages_target_user instead of is_admin_of.
--      Lets managers materialise a draft row for an employee + week
--      without the SELECT-then-INSERT race.
--
-- Safe to re-run.

create or replace function public.manager_get_or_create_timesheet(
    p_user_id    bigint,
    p_week_start date
)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
    v_org_id bigint;
    v_ts_id  bigint;
begin
    select organisation_id into v_org_id
      from public.users
     where id = p_user_id;
    if v_org_id is null then
        raise exception 'User not found';
    end if;
    if not public.user_manages_target_user(p_user_id) then
        raise exception 'Not authorised — you do not manage this employee';
    end if;

    insert into public.timesheets (organisation_id, user_id, week_start)
    values (v_org_id, p_user_id, p_week_start)
    on conflict (user_id, week_start) do update set id = public.timesheets.id
    returning id into v_ts_id;

    return v_ts_id;
end$$;

revoke all on function public.manager_get_or_create_timesheet(bigint, date) from public;
grant execute on function public.manager_get_or_create_timesheet(bigint, date) to authenticated;

-- RLS: managers can do anything to timesheets for users they manage.
-- The existing narrow "managers update dept timesheets" policy stays in
-- place — RLS unions permissive policies, so the broader one strictly
-- adds access.
drop policy if exists "managers manage dept timesheets" on public.timesheets;
create policy "managers manage dept timesheets"
    on public.timesheets for all to authenticated
    using (public.user_manages_target_user(user_id))
    with check (public.user_manages_target_user(user_id));

-- Same for entries — managers need to edit hours, not just read.
drop policy if exists "managers manage dept entries" on public.timesheet_entries;
create policy "managers manage dept entries"
    on public.timesheet_entries for all to authenticated
    using (
        exists (
            select 1 from public.timesheets ts
            where ts.id = timesheet_entries.timesheet_id
              and public.user_manages_target_user(ts.user_id)
        )
    )
    with check (
        exists (
            select 1 from public.timesheets ts
            where ts.id = timesheet_entries.timesheet_id
              and public.user_manages_target_user(ts.user_id)
        )
    );
