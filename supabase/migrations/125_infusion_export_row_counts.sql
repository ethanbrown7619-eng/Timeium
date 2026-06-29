-- 125_infusion_export_row_counts.sql
-- Live counter that matches the Infusion export's row-emission rule:
--   one row per (entry, day) where day_hours > 0
-- Broken down by timesheet status so the developer can tell at a glance
-- how many rows are already exported vs pending the next click.
--
-- Lets us verify accuracy of past exports even when the log entry from
-- migration 124 is missing (anything exported before 124 went live).
-- For a fully-exported week, "already_exported" equals what was in the
-- downloaded XLSX — open the file, compare row counts.
--
-- SECURITY DEFINER + admin auth so a developer (who is also an admin)
-- gets the data without needing direct read on timesheets / entries.
--
-- Safe to re-run.

create or replace function public.infusion_export_row_counts(
    p_org_id     bigint,
    p_week_start date
)
returns table (
    already_exported integer,
    pending_approved integer
)
language plpgsql stable security definer set search_path = public
as $$
begin
    if not public.is_admin_of(p_org_id) then
        raise exception 'Not authorised';
    end if;

    return query
    select
        coalesce(sum(case when t.status = 'exported' then day_count else 0 end), 0)::integer,
        coalesce(sum(case when t.status = 'approved' then day_count else 0 end), 0)::integer
      from (
        select
            e.timesheet_id,
            (case when coalesce(e.mon_hours,0) > 0 then 1 else 0 end) +
            (case when coalesce(e.tue_hours,0) > 0 then 1 else 0 end) +
            (case when coalesce(e.wed_hours,0) > 0 then 1 else 0 end) +
            (case when coalesce(e.thu_hours,0) > 0 then 1 else 0 end) +
            (case when coalesce(e.fri_hours,0) > 0 then 1 else 0 end) +
            (case when coalesce(e.sat_hours,0) > 0 then 1 else 0 end) +
            (case when coalesce(e.sun_hours,0) > 0 then 1 else 0 end) as day_count
          from public.timesheet_entries e
      ) ec
      join public.timesheets t on t.id = ec.timesheet_id
     where t.organisation_id = p_org_id
       and t.week_start = p_week_start
       and t.status in ('approved', 'exported');
end$$;

grant execute on function public.infusion_export_row_counts(bigint, date) to authenticated;
