-- 055_audit5_quick_wins.sql
--
-- Follow-up to 054. Closes the medium / low items from audit pass #5.
-- Idempotent. Safe to re-run.
--
-- F3 — provision_employee_login leaked user-existence and target org_id
--      via distinct error messages. Collapse both auth-related branches
--      to a single "Not authorised" with no org id interpolation.
--
-- F8 — apply_leave_to_timesheet and clear_leave_from_timesheet raised on
--      the first locked week, forcing the manager to retry once per
--      locked week. Now collect every locked week and raise once with
--      the full list.
--
-- F1 — clear_leave_from_timesheet's error message couldn't tell the
--      manager whether they were hitting a locked week from the OLD
--      range (existing leave entries that are now locked) or from a
--      direct collision. Re-phrased so the manager understands the
--      blocker is the leave hours already written into the locked
--      timesheet, not their proposed new range.
--
-- F2 — apply_leave_to_timesheet now raises if the request would write
--      zero entries (e.g. weekend-only range with skip_weekends=true).
--      The whole approve transaction rolls back; the request stays
--      pending so the manager can adjust skip_weekends or reject.
--
-- F14 — get_or_create_timesheet and import_last_week_tasks each had a
--       SELECT-then-INSERT race window. Two simultaneous tabs opening
--       the same fresh week could both insert and the second hit the
--       (user_id, week_start) unique constraint. Switch to
--       INSERT … ON CONFLICT … DO UPDATE SET id=id RETURNING id so the
--       caller always gets back the canonical row id even on conflict.

--------------------------------------------------------------------------------
-- F3: provision_employee_login - single generic error for both auth paths
--------------------------------------------------------------------------------

create or replace function public.provision_employee_login(p_user_id bigint)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_email        text;
    v_existing_uid uuid;
    v_uid          uuid;
    v_target_org   bigint;
begin
    select email, auth_user_id, organisation_id
      into v_email, v_existing_uid, v_target_org
      from public.users
     where id = p_user_id;

    -- Combine "user not found" and "caller not admin" into one generic
    -- error so a non-admin can't probe the user-id space or learn which
    -- org a user belongs to. Both legitimate-failure paths get the same
    -- response.
    if v_target_org is null or not public.is_admin_of(v_target_org) then
        raise exception 'Not authorised';
    end if;

    if v_email is null or trim(v_email) = '' then
        raise exception 'Employee has no email address';
    end if;

    if v_existing_uid is not null then
        return;
    end if;

    select id into v_uid
      from auth.users
     where lower(email) = lower(v_email);

    if v_uid is null then
        v_uid := gen_random_uuid();

        insert into auth.users (
            instance_id, id, aud, role, email,
            encrypted_password, email_confirmed_at,
            created_at, updated_at,
            raw_app_meta_data, raw_user_meta_data,
            is_super_admin,
            confirmation_token, recovery_token,
            email_change_token_new, email_change,
            phone_change, phone_change_token,
            email_change_token_current, reauthentication_token
        ) values (
            '00000000-0000-0000-0000-000000000000'::uuid,
            v_uid,
            'authenticated',
            'authenticated',
            lower(trim(v_email)),
            crypt('PASSWORD', gen_salt('bf')),
            now(),
            now(), now(),
            '{"provider":"email","providers":["email"]}'::jsonb,
            '{}'::jsonb,
            false,
            '', '', '', '', '', '', '', ''
        );

        insert into auth.identities (
            id, user_id, provider_id, identity_data,
            provider, last_sign_in_at, created_at, updated_at
        ) values (
            v_uid, v_uid, lower(trim(v_email)),
            jsonb_build_object('sub', v_uid::text, 'email', lower(trim(v_email))),
            'email', now(), now(), now()
        );
    end if;

    update public.users
       set auth_user_id = v_uid,
           must_change_password = true
     where id = p_user_id;
end;
$$;

grant execute on function public.provision_employee_login(bigint) to authenticated;

--------------------------------------------------------------------------------
-- F8 + F1 + F2: apply_leave_to_timesheet
--   - Aggregate every locked week into one raise instead of erroring per
--     iteration (F8).
--   - Phrase the error so it's clear the blocker is hours already written
--     into the locked timesheet, not the proposed range (F1).
--   - Raise if the request would write zero entries — happens when every
--     day in the range is a skipped weekend (F2).
--------------------------------------------------------------------------------

create or replace function public.apply_leave_to_timesheet(p_request_id bigint)
returns void
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_req          public.leave_requests;
    v_job_id       bigint;
    v_day          date;
    v_week_start   date;
    v_ts_id        bigint;
    v_entry_id     bigint;
    v_dow          int;
    v_col          text;
    v_locked_weeks date[];
    v_applied_any  boolean := false;
begin
    select * into v_req from public.leave_requests where id = p_request_id;
    if v_req.id is null then
        raise exception 'Leave request not found';
    end if;
    if not public.is_manager_of(v_req.organisation_id) then
        raise exception 'Not authorised';
    end if;

    -- Collect every week the leave would touch that's already locked.
    -- One pass, one error, all weeks listed.
    select array_agg(t.week_start order by t.week_start)
      into v_locked_weeks
      from public.timesheets t
      join (
          select distinct (gs::date - (extract(isodow from gs)::int - 1))::date as wk
            from generate_series(v_req.start_date, v_req.end_date, '1 day'::interval) gs
           where not (v_req.skip_weekends and extract(isodow from gs) >= 6)
      ) weeks on weeks.wk = t.week_start
     where t.user_id = v_req.user_id
       and t.status in ('submitted', 'approved');

    if v_locked_weeks is not null and array_length(v_locked_weeks, 1) > 0 then
        raise exception 'Cannot apply leave: timesheets already submitted/approved for week(s) %. Un-submit them first, then retry.',
            array_to_string(v_locked_weeks, ', ');
    end if;

    select j.id into v_job_id
      from public.jobs j
      where j.organisation_id = v_req.organisation_id
        and j.is_leave = true
        and j.leave_type_id = v_req.leave_type_id
      limit 1;

    if v_job_id is null then
        raise exception 'No leave job configured for this leave type. Ask an admin to create one in Configure > Jobs.';
    end if;

    v_day := v_req.start_date;
    while v_day <= v_req.end_date loop
        v_dow := extract(isodow from v_day)::int;
        if v_req.skip_weekends and v_dow >= 6 then
            v_day := v_day + 1;
            continue;
        end if;

        v_week_start := v_day - (v_dow - 1);
        select id into v_ts_id
          from public.timesheets
          where user_id = v_req.user_id and week_start = v_week_start
          limit 1;

        if v_ts_id is null then
            insert into public.timesheets (organisation_id, user_id, week_start, status)
              values (v_req.organisation_id, v_req.user_id, v_week_start, 'draft')
              returning id into v_ts_id;
        end if;

        select id into v_entry_id
          from public.timesheet_entries
          where timesheet_id = v_ts_id and job_id = v_job_id
          limit 1;

        if v_entry_id is null then
            insert into public.timesheet_entries (timesheet_id, job_id, description)
              values (v_ts_id, v_job_id,
                case when v_req.reason is not null and trim(v_req.reason) <> ''
                     then v_req.reason else null end)
              returning id into v_entry_id;
        end if;

        v_col := case v_dow
            when 1 then 'mon_hours' when 2 then 'tue_hours'
            when 3 then 'wed_hours' when 4 then 'thu_hours'
            when 5 then 'fri_hours' when 6 then 'sat_hours'
            when 7 then 'sun_hours' end;

        execute format('update public.timesheet_entries set %I = $1 where id = $2', v_col)
          using v_req.hours_per_day, v_entry_id;

        v_applied_any := true;
        v_day := v_day + 1;
    end loop;

    -- F2: refuse a request that wrote zero entries. The most common cause
    -- is a weekend-only range with skip_weekends=true; the request would
    -- otherwise sit as 'approved' with no actual leave applied, which is
    -- misleading. Rolls back the parent's status='approved' update too.
    if not v_applied_any then
        raise exception 'Leave request would write zero entries (every day in the range is a skipped weekend). Toggle skip_weekends or reject the request instead.';
    end if;

    update public.leave_requests
       set applied_to_timesheet = true,
           applied_at = now()
     where id = p_request_id;
end;
$$;

grant execute on function public.apply_leave_to_timesheet(bigint) to authenticated;

--------------------------------------------------------------------------------
-- F8 + F1: clear_leave_from_timesheet
--   - Aggregate locked weeks into one raise.
--   - Phrase the error so the manager understands the blocker is the
--     leave hours already written into those locked timesheets — i.e.
--     they have to un-submit those weeks before the leave can be moved
--     or revoked, because clearing the leave means modifying signed-off
--     timesheets.
--------------------------------------------------------------------------------

create or replace function public.clear_leave_from_timesheet(p_request_id bigint)
returns void
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_req          public.leave_requests;
    v_job_id       bigint;
    v_day          date;
    v_week_start   date;
    v_ts_id        bigint;
    v_entry_id     bigint;
    v_dow          int;
    v_col          text;
    v_locked_weeks date[];
begin
    select * into v_req from public.leave_requests where id = p_request_id;
    if v_req.id is null then
        raise exception 'Leave request not found';
    end if;
    if not public.is_manager_of(v_req.organisation_id) then
        raise exception 'Not authorised';
    end if;

    select array_agg(t.week_start order by t.week_start)
      into v_locked_weeks
      from public.timesheets t
      join (
          select distinct (gs::date - (extract(isodow from gs)::int - 1))::date as wk
            from generate_series(v_req.start_date, v_req.end_date, '1 day'::interval) gs
           where not (v_req.skip_weekends and extract(isodow from gs) >= 6)
      ) weeks on weeks.wk = t.week_start
     where t.user_id = v_req.user_id
       and t.status in ('submitted', 'approved');

    if v_locked_weeks is not null and array_length(v_locked_weeks, 1) > 0 then
        raise exception 'Cannot modify or revoke this leave: it has hours on submitted/approved timesheet(s) for week(s) %. Un-submit those weeks first, then retry.',
            array_to_string(v_locked_weeks, ', ');
    end if;

    select j.id into v_job_id
      from public.jobs j
      where j.organisation_id = v_req.organisation_id
        and j.is_leave = true
        and j.leave_type_id = v_req.leave_type_id
      limit 1;

    if v_job_id is null then
        return;
    end if;

    v_day := v_req.start_date;
    while v_day <= v_req.end_date loop
        v_dow := extract(isodow from v_day)::int;
        if v_req.skip_weekends and v_dow >= 6 then
            v_day := v_day + 1;
            continue;
        end if;

        v_week_start := v_day - (v_dow - 1);
        select id into v_ts_id
          from public.timesheets
          where user_id = v_req.user_id and week_start = v_week_start
          limit 1;

        if v_ts_id is not null then
            select id into v_entry_id
              from public.timesheet_entries
              where timesheet_id = v_ts_id and job_id = v_job_id
              limit 1;

            if v_entry_id is not null then
                v_col := case v_dow
                    when 1 then 'mon_hours' when 2 then 'tue_hours'
                    when 3 then 'wed_hours' when 4 then 'thu_hours'
                    when 5 then 'fri_hours' when 6 then 'sat_hours'
                    when 7 then 'sun_hours' end;

                execute format('update public.timesheet_entries set %I = 0 where id = $1', v_col)
                  using v_entry_id;

                execute format($f$
                    delete from public.timesheet_entries
                    where id = $1
                      and mon_hours = 0 and tue_hours = 0 and wed_hours = 0
                      and thu_hours = 0 and fri_hours = 0 and sat_hours = 0
                      and sun_hours = 0
                $f$) using v_entry_id;
            end if;
        end if;

        v_day := v_day + 1;
    end loop;
end;
$$;

grant execute on function public.clear_leave_from_timesheet(bigint) to authenticated;

--------------------------------------------------------------------------------
-- F14: get_or_create_timesheet — race-free via ON CONFLICT
--   Two simultaneous tabs opening the same fresh week each ran SELECT
--   then INSERT. Both saw "no row", both inserted, second hit the
--   (user_id, week_start) unique constraint. Use INSERT … ON CONFLICT …
--   DO UPDATE SET id=id RETURNING id so the second always gets back the
--   canonical id (the bogus DO UPDATE is required to make RETURNING
--   work on the conflicting path).
--------------------------------------------------------------------------------

create or replace function public.get_or_create_timesheet(
    p_week_start date
)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
    v_user_id bigint;
    v_org_id  bigint;
    v_ts_id   bigint;
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
    returning id into v_ts_id;

    return v_ts_id;
end$$;

grant execute on function public.get_or_create_timesheet(date) to authenticated;

--------------------------------------------------------------------------------
-- F14: import_last_week_tasks - same race fix on its create-current-week
--   step. Behaviour otherwise unchanged from 031.
--------------------------------------------------------------------------------

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
    -- current week. Hours are not copied.
    insert into public.timesheet_entries (
        timesheet_id, job_id, dept_code_id, task_id, description, sort_order
    )
    select v_current_ts, e.job_id, e.dept_code_id, e.task_id, e.description, e.sort_order
      from public.timesheet_entries e
     where e.timesheet_id = v_prev_ts
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
