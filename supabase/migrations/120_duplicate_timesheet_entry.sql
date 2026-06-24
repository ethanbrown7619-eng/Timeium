-- 120_duplicate_timesheet_entry.sql
-- RPC to duplicate a timesheet entry directly beneath its source row.
-- Naive client-side INSERT-then-bump leaves a window where the new row
-- and the bumped rows have colliding sort_order values; doing the shift
-- and insert in a single transaction avoids that.
--
-- SECURITY INVOKER on purpose — the caller's existing RLS on
-- timesheet_entries (own draft/rejected entries, admin org-wide, or
-- managed dept after 118) governs whether the shift and insert succeed.
--
-- Copies job/task/dept/description; hours stay zero so the duplicate is
-- a clean structural copy ready for a fresh week's hours.
--
-- Safe to re-run.

create or replace function public.duplicate_timesheet_entry(p_entry_id bigint)
returns public.timesheet_entries
language plpgsql security invoker set search_path = public
as $$
declare
    v_src public.timesheet_entries;
    v_new public.timesheet_entries;
begin
    select * into v_src from public.timesheet_entries where id = p_entry_id;
    if v_src.id is null then
        raise exception 'Entry not found';
    end if;

    -- Shift subsequent rows in the same timesheet to make room.
    update public.timesheet_entries
       set sort_order = sort_order + 1
     where timesheet_id = v_src.timesheet_id
       and sort_order   > v_src.sort_order;

    insert into public.timesheet_entries (
        timesheet_id, job_id, task_id, dept_code_id, description, sort_order
    )
    values (
        v_src.timesheet_id,
        v_src.job_id,
        v_src.task_id,
        v_src.dept_code_id,
        v_src.description,
        v_src.sort_order + 1
    )
    returning * into v_new;

    return v_new;
end$$;

grant execute on function public.duplicate_timesheet_entry(bigint) to authenticated;
