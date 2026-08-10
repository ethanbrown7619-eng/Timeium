-- 168_leave_only_via_request.sql
-- Leave can no longer be put on a timesheet by hand.
--
-- Leave hours are supposed to arrive one way: the employee (or a manager on
-- their behalf) raises a leave request, it gets approved, and
-- populate_timesheet_for_leave writes the hours. Hand-entering a leave job
-- straight onto the timesheet sidesteps the approval, the balance
-- deduction, and the leave calendar — the sheet says "Annual Leave" but no
-- request exists anywhere behind it.
--
-- The job picker in the timesheet editor now hides is_leave jobs from
-- employees (admin edit mode keeps them). That leaves two server-side
-- routes, and this migration closes both:
--
--   * import_last_week_tasks — copied every row from the previous week,
--     leave rows included, so last week's approved leave re-appeared on the
--     new sheet with no request behind it.
--   * duplicate_timesheet_entry — "Duplicate row" on an existing leave
--     line minted a second, unbacked leave line.
--
-- NOT touched on purpose:
--   * populate_timesheet_for_leave — that IS the sanctioned route.
--   * The public-holiday autofill, which inserts the org's configured
--     public_holiday_job_id directly. It's automatic rather than
--     hand-entered, and it's driven by the org holiday table, so it stays
--     as-is even when that job is leave-tagged.
--   * timesheet_entries RLS — no blanket trigger here. Every UI route is
--     closed; a DB-level block would also have to carve out the two cases
--     above.
--
-- Safe to re-run.

--------------------------------------------------------------------------------
-- import_last_week_tasks — skip leave rows when copying
--------------------------------------------------------------------------------
-- Body carried forward from 055 (ON CONFLICT race fix + the dedup against
-- rows already on the current week); the only change is the leave filter.
-- The filter is written as NOT EXISTS rather than a join so entries with a
-- null job_id (a blank row the employee added but never filled in) still
-- copy exactly as they did before.

create or replace function public.import_last_week_tasks(
    p_week_start date
)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
    v_user_id     bigint;
    v_org_id      bigint;
    v_current_ts  bigint;
    v_prev_ts     bigint;
    v_count       integer := 0;
begin
    select u.id, u.organisation_id into v_user_id, v_org_id
    from public.users u
    where u.auth_user_id = auth.uid();

    if v_user_id is null then
        raise exception 'no linked employee record';
    end if;

    insert into public.timesheets (organisation_id, user_id, week_start)
    values (v_org_id, v_user_id, p_week_start)
    on conflict (user_id, week_start) do update set id = public.timesheets.id
    returning id into v_current_ts;

    select id into v_prev_ts
    from public.timesheets
    where user_id = v_user_id and week_start = p_week_start - interval '7 days';

    if v_prev_ts is null then
        return 0;
    end if;

    -- Copy distinct (job_id, dept_code_id, task_id, description) tuples
    -- from the previous week, skipping any that already exist on the
    -- current week. Hours are not copied. Leave rows are not copied at all.
    insert into public.timesheet_entries (
        timesheet_id, job_id, dept_code_id, task_id, description, sort_order
    )
    select v_current_ts, e.job_id, e.dept_code_id, e.task_id, e.description, e.sort_order
      from public.timesheet_entries e
     where e.timesheet_id = v_prev_ts
       and not exists (
           select 1 from public.jobs j
            where j.id = e.job_id
              and j.is_leave = true
       )
       and not exists (
           select 1 from public.timesheet_entries c
            where c.timesheet_id = v_current_ts
              and c.job_id is not distinct from e.job_id
              and c.dept_code_id is not distinct from e.dept_code_id
              and c.task_id is not distinct from e.task_id
              and c.description is not distinct from e.description
       );

    get diagnostics v_count = row_count;
    return v_count;
end$$;

grant execute on function public.import_last_week_tasks(date) to authenticated;

--------------------------------------------------------------------------------
-- duplicate_timesheet_entry — refuse to duplicate a leave row
--------------------------------------------------------------------------------
-- Body carried forward from 120 (atomic sort_order shift + insert); the
-- only change is the leave guard.
--
-- The block is aimed at an employee duplicating leave on their OWN sheet.
-- Admins keep full control, and a manager working on someone else's sheet
-- is left alone as well — they're the ones who fix leave when it's wrong,
-- and RLS already decides whose sheets they can touch at all.
--
-- The test is jobs.is_leave — the "Leave" tick box on the job in Configure,
-- nothing more. Note that jobs.leave_type_id is NOT the mapping to use for
-- anything: it is a stale half-populated column. The live type→job mapping
-- lives on leave_types.job_id (migration 131), which is what Configure edits
-- and what populate_timesheet_for_leave reads.

create or replace function public.duplicate_timesheet_entry(p_entry_id bigint)
returns public.timesheet_entries
language plpgsql security invoker set search_path = public
as $$
declare
    v_src      public.timesheet_entries;
    v_new      public.timesheet_entries;
    v_org_id   bigint;
    v_owner_id bigint;
    v_caller   bigint;
begin
    select * into v_src from public.timesheet_entries where id = p_entry_id;
    if v_src.id is null then
        raise exception 'Entry not found';
    end if;

    if exists (select 1 from public.jobs j
                where j.id = v_src.job_id and j.is_leave = true) then
        select t.organisation_id, t.user_id into v_org_id, v_owner_id
          from public.timesheets t
         where t.id = v_src.timesheet_id;

        select u.id into v_caller
          from public.users u
         where u.auth_user_id = auth.uid();

        if v_owner_id = v_caller and not public.is_admin_of(v_org_id) then
            raise exception
                'Leave goes on your timesheet by requesting it on the Leave page';
        end if;
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
