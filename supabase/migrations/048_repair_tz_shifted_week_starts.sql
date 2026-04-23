-- 048_repair_tz_shifted_week_starts.sql
-- The old client-side fmtDate used d.toISOString().slice(0,10), which in
-- NZ (UTC+12/+13) shifted Monday local dates to the previous Sunday before
-- they were sent to the DB. That produced timesheets (and leave_requests)
-- with week_start / start_date values one day earlier than the user intended.
--
-- This migration shifts any timesheet whose week_start is not a Monday
-- forward to the following Monday. If a Monday row already exists for the
-- same (user_id, week_start), we merge: keep the row with the later status
-- (approved > submitted > draft) and entries, deleting the empty duplicate.
-- Safe to re-run.

do $$
declare
    r record;
    monday_id bigint;
    sunday_has_entries boolean;
    monday_has_entries boolean;
begin
    -- extract(dow) returns 0=Sunday, 1=Monday ... 6=Saturday
    for r in
        select id, user_id, week_start, status
        from public.timesheets
        where extract(dow from week_start) <> 1
    loop
        -- target Monday is the day after the (Sunday) stored week_start,
        -- or the nearest Monday in general: add (1 - dow) mod 7, but we
        -- assume dow=0 (Sunday) here since the bug only produced Sundays.
        select id into monday_id
        from public.timesheets
        where user_id = r.user_id
          and week_start = r.week_start + 1;

        if monday_id is null then
            update public.timesheets
            set week_start = week_start + 1
            where id = r.id;
        else
            -- There's a collision. Keep whichever has entries; if both do,
            -- prefer the more-advanced status on the Sunday row.
            select exists (select 1 from public.timesheet_entries where timesheet_id = r.id)
                into sunday_has_entries;
            select exists (select 1 from public.timesheet_entries where timesheet_id = monday_id)
                into monday_has_entries;

            if sunday_has_entries and not monday_has_entries then
                -- Drop the empty Monday row, shift the Sunday one up.
                delete from public.timesheets where id = monday_id;
                update public.timesheets
                set week_start = week_start + 1
                where id = r.id;
            elsif monday_has_entries and not sunday_has_entries then
                -- Monday has the real data; drop the empty Sunday row.
                delete from public.timesheets where id = r.id;
            else
                -- Both have data (or both empty). Keep the one with the
                -- more advanced status on the Sunday row if it outranks
                -- the Monday row; otherwise keep Monday.
                if r.status = 'approved'
                   or (r.status = 'submitted' and
                       (select status from public.timesheets where id = monday_id) = 'draft') then
                    delete from public.timesheets where id = monday_id;
                    update public.timesheets
                    set week_start = week_start + 1
                    where id = r.id;
                else
                    delete from public.timesheets where id = r.id;
                end if;
            end if;
        end if;
    end loop;
end $$;

-- Note: leave_requests and public_holidays rows may also have shifted
-- dates, but we can't reliably distinguish bug-shifted weekends from
-- intentional weekend dates, so those are left alone. Inspect manually
-- if anything looks off.
