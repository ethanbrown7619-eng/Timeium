-- 054_security_hardening.sql
--
-- Closes the security findings from audit pass #4:
--   A.1 / B.1 in audit -> provision_employee_login was callable by any
--                         authenticated user, allowing cross-tenant account
--                         takeover with default password "PASSWORD".
--   B.1 (timesheets)  -> the "users manage own" RLS policies had no status
--                         guard, so an employee could edit their own
--                         submitted/approved timesheet via direct REST calls
--                         (UI hid the buttons; RLS didn't enforce).
--   B.2 (leave_requests) -> same shape: employee could mutate approved leave
--                            requests via direct REST.
--   A.2               -> approve / update / revoke of leave silently mutated
--                         hours on already-submitted/approved weekly
--                         timesheets, invalidating manager sign-off without
--                         notification.
--   B.5               -> applied_to_timesheet was set true even when every
--                         day in the request was a skipped weekend (no
--                         actual entries written).
--   D.4 (db side)     -> *_hours columns had no >= 0 constraint, so a
--                         negative value pasted past the client clamp would
--                         persist.
--
-- Idempotent. Safe to re-run.

--------------------------------------------------------------------------------
-- A.1 / B.1: provision_employee_login - require admin caller
--------------------------------------------------------------------------------

create or replace function public.provision_employee_login(p_user_id bigint)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_email       text;
    v_existing_uid uuid;
    v_uid         uuid;
    v_target_org  bigint;
begin
    -- Look up the target user's org first so we can authorise the caller.
    select email, auth_user_id, organisation_id
      into v_email, v_existing_uid, v_target_org
      from public.users
     where id = p_user_id;

    if v_target_org is null then
        raise exception 'Employee not found';
    end if;

    -- Caller must be an admin of the same organisation as the target user.
    -- Without this check, any authenticated user could provision a login for
    -- any employee in any org with default password "PASSWORD" and then sign
    -- in as them. is_admin_of() returns true for both org admins and
    -- developers (cross-org).
    if not public.is_admin_of(v_target_org) then
        raise exception 'Not authorised: admin of organisation % required', v_target_org;
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
-- B.1: timesheets - RLS status guard
--   The previous "users manage own timesheets" policy was for-all with no
--   status check in WITH CHECK. Splitting per-command lets us:
--     - allow SELECT regardless of status (employee views their archive)
--     - allow INSERT only as a draft (creating new weekly rows)
--     - allow UPDATE only when current status is draft or rejected, with
--       new status restricted to draft / submitted / rejected (the submit
--       path is draft -> submitted; re-submit is rejected -> submitted)
--     - allow DELETE only on draft / rejected
--
--   The admin / manager policies are unchanged (defined in 031, 053).
--------------------------------------------------------------------------------

drop policy if exists "users manage own timesheets" on public.timesheets;
drop policy if exists "users select own timesheets" on public.timesheets;
drop policy if exists "users insert own draft timesheets" on public.timesheets;
drop policy if exists "users update own unlocked timesheets" on public.timesheets;
drop policy if exists "users delete own unlocked timesheets" on public.timesheets;

create policy "users select own timesheets"
    on public.timesheets for select
    to authenticated
    using (
        exists (
            select 1 from public.users u
             where u.id = timesheets.user_id
               and u.auth_user_id = auth.uid()
        )
    );

create policy "users insert own draft timesheets"
    on public.timesheets for insert
    to authenticated
    with check (
        timesheets.status = 'draft'
        and exists (
            select 1 from public.users u
             where u.id = timesheets.user_id
               and u.auth_user_id = auth.uid()
        )
    );

create policy "users update own unlocked timesheets"
    on public.timesheets for update
    to authenticated
    using (
        timesheets.status in ('draft', 'rejected')
        and exists (
            select 1 from public.users u
             where u.id = timesheets.user_id
               and u.auth_user_id = auth.uid()
        )
    )
    with check (
        timesheets.status in ('draft', 'submitted', 'rejected')
        and exists (
            select 1 from public.users u
             where u.id = timesheets.user_id
               and u.auth_user_id = auth.uid()
        )
    );

create policy "users delete own unlocked timesheets"
    on public.timesheets for delete
    to authenticated
    using (
        timesheets.status in ('draft', 'rejected')
        and exists (
            select 1 from public.users u
             where u.id = timesheets.user_id
               and u.auth_user_id = auth.uid()
        )
    );

--------------------------------------------------------------------------------
-- B.1 (entries): timesheet_entries - status guard via parent timesheet
--   Inserts/updates/deletes only allowed when the parent timesheet is
--   draft or rejected. Selects unchanged.
--------------------------------------------------------------------------------

drop policy if exists "users manage own entries" on public.timesheet_entries;
drop policy if exists "users select own entries" on public.timesheet_entries;
drop policy if exists "users insert own entries" on public.timesheet_entries;
drop policy if exists "users update own entries" on public.timesheet_entries;
drop policy if exists "users delete own entries" on public.timesheet_entries;

create policy "users select own entries"
    on public.timesheet_entries for select
    to authenticated
    using (
        exists (
            select 1
              from public.timesheets t
              join public.users u on u.id = t.user_id
             where t.id = timesheet_entries.timesheet_id
               and u.auth_user_id = auth.uid()
        )
    );

create policy "users insert own entries"
    on public.timesheet_entries for insert
    to authenticated
    with check (
        exists (
            select 1
              from public.timesheets t
              join public.users u on u.id = t.user_id
             where t.id = timesheet_entries.timesheet_id
               and u.auth_user_id = auth.uid()
               and t.status in ('draft', 'rejected')
        )
    );

create policy "users update own entries"
    on public.timesheet_entries for update
    to authenticated
    using (
        exists (
            select 1
              from public.timesheets t
              join public.users u on u.id = t.user_id
             where t.id = timesheet_entries.timesheet_id
               and u.auth_user_id = auth.uid()
               and t.status in ('draft', 'rejected')
        )
    )
    with check (
        exists (
            select 1
              from public.timesheets t
              join public.users u on u.id = t.user_id
             where t.id = timesheet_entries.timesheet_id
               and u.auth_user_id = auth.uid()
               and t.status in ('draft', 'rejected')
        )
    );

create policy "users delete own entries"
    on public.timesheet_entries for delete
    to authenticated
    using (
        exists (
            select 1
              from public.timesheets t
              join public.users u on u.id = t.user_id
             where t.id = timesheet_entries.timesheet_id
               and u.auth_user_id = auth.uid()
               and t.status in ('draft', 'rejected')
        )
    );

--------------------------------------------------------------------------------
-- B.2: leave_requests - employees can only act on their own pending rows
--   SELECT: own row (any status)
--   INSERT: own row, status must be 'pending'
--   UPDATE: own row, only while pending; allowed transitions are
--           pending -> pending and pending -> cancelled. Going from approved
--           or rejected to anything else has to go through revoke RPC.
--   DELETE: own row, only while pending.
--------------------------------------------------------------------------------

drop policy if exists "employees own leave_requests" on public.leave_requests;
drop policy if exists "employees select own leave_requests" on public.leave_requests;
drop policy if exists "employees insert own pending leave_requests" on public.leave_requests;
drop policy if exists "employees update own pending leave_requests" on public.leave_requests;
drop policy if exists "employees delete own pending leave_requests" on public.leave_requests;

create policy "employees select own leave_requests"
    on public.leave_requests for select
    to authenticated
    using (
        exists (
            select 1 from public.users u
             where u.id = leave_requests.user_id
               and u.auth_user_id = auth.uid()
        )
    );

create policy "employees insert own pending leave_requests"
    on public.leave_requests for insert
    to authenticated
    with check (
        leave_requests.status = 'pending'
        and exists (
            select 1 from public.users u
             where u.id = leave_requests.user_id
               and u.auth_user_id = auth.uid()
        )
    );

create policy "employees update own pending leave_requests"
    on public.leave_requests for update
    to authenticated
    using (
        leave_requests.status = 'pending'
        and exists (
            select 1 from public.users u
             where u.id = leave_requests.user_id
               and u.auth_user_id = auth.uid()
        )
    )
    with check (
        leave_requests.status in ('pending', 'cancelled')
        and exists (
            select 1 from public.users u
             where u.id = leave_requests.user_id
               and u.auth_user_id = auth.uid()
        )
    );

create policy "employees delete own pending leave_requests"
    on public.leave_requests for delete
    to authenticated
    using (
        leave_requests.status = 'pending'
        and exists (
            select 1 from public.users u
             where u.id = leave_requests.user_id
               and u.auth_user_id = auth.uid()
        )
    );

--------------------------------------------------------------------------------
-- A.2: apply_leave_to_timesheet - hard refuse on locked weeks
--   Before writing, scan every week the leave touches and raise if any
--   has status in ('submitted','approved'). The manager has to un-submit
--   / un-approve those weeks first. This preserves payroll signature
--   integrity at the cost of one extra manual step.
--------------------------------------------------------------------------------

create or replace function public.apply_leave_to_timesheet(p_request_id bigint)
returns void
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_req         public.leave_requests;
    v_job_id      bigint;
    v_day         date;
    v_week_start  date;
    v_ts_id       bigint;
    v_entry_id    bigint;
    v_dow         int;
    v_col         text;
    v_locked      record;
    v_applied_any boolean := false;
begin
    select * into v_req from public.leave_requests where id = p_request_id;
    if v_req.id is null then
        raise exception 'Leave request not found';
    end if;
    if not public.is_manager_of(v_req.organisation_id) then
        raise exception 'Not authorised';
    end if;

    -- Refuse if any week the leave touches is already locked. Build the
    -- list of week_start values that this leave would write into and check
    -- in one pass.
    for v_locked in
        with weeks as (
            select distinct (gs::date - (extract(isodow from gs)::int - 1))::date as wk
              from generate_series(v_req.start_date, v_req.end_date, '1 day'::interval) gs
             where not (v_req.skip_weekends and extract(isodow from gs) >= 6)
        )
        select t.week_start, t.status
          from public.timesheets t
          join weeks w on w.wk = t.week_start
         where t.user_id = v_req.user_id
           and t.status in ('submitted', 'approved')
        order by t.week_start
    loop
        raise exception 'Cannot apply leave: timesheet for week % is %. Un-submit it first.',
            to_char(v_locked.week_start, 'YYYY-MM-DD'), v_locked.status;
    end loop;

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

    -- B.5: only mark applied_to_timesheet=true if at least one day was
    -- actually written. A weekend-only request with skip_weekends=true
    -- writes nothing; the flag should reflect that.
    update public.leave_requests
       set applied_to_timesheet = v_applied_any,
           applied_at = case when v_applied_any then now() else null end
     where id = p_request_id;
end;
$$;

grant execute on function public.apply_leave_to_timesheet(bigint) to authenticated;

--------------------------------------------------------------------------------
-- A.2: clear_leave_from_timesheet - same hard-refuse on locked weeks
--   When revoking or editing approved leave, the same logic applies: the
--   manager has to un-submit any locked weeks before the leave can be
--   removed.
--------------------------------------------------------------------------------

create or replace function public.clear_leave_from_timesheet(p_request_id bigint)
returns void
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_req       public.leave_requests;
    v_job_id    bigint;
    v_day       date;
    v_week_start date;
    v_ts_id     bigint;
    v_entry_id  bigint;
    v_dow       int;
    v_col       text;
    v_locked    record;
begin
    select * into v_req from public.leave_requests where id = p_request_id;
    if v_req.id is null then
        raise exception 'Leave request not found';
    end if;
    if not public.is_manager_of(v_req.organisation_id) then
        raise exception 'Not authorised';
    end if;

    -- Refuse if any week the leave touched is locked.
    for v_locked in
        with weeks as (
            select distinct (gs::date - (extract(isodow from gs)::int - 1))::date as wk
              from generate_series(v_req.start_date, v_req.end_date, '1 day'::interval) gs
             where not (v_req.skip_weekends and extract(isodow from gs) >= 6)
        )
        select t.week_start, t.status
          from public.timesheets t
          join weeks w on w.wk = t.week_start
         where t.user_id = v_req.user_id
           and t.status in ('submitted', 'approved')
        order by t.week_start
    loop
        raise exception 'Cannot modify leave: timesheet for week % is %. Un-submit it first.',
            to_char(v_locked.week_start, 'YYYY-MM-DD'), v_locked.status;
    end loop;

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
-- A.2: approve_leave_request - delegate to apply_leave_to_timesheet for
--   the locked-week check and the applied_to_timesheet flag write.
--   Behaviour is otherwise unchanged from 042.
--------------------------------------------------------------------------------

create or replace function public.approve_leave_request(
    p_request_id bigint,
    p_note       text default null
)
returns void
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_req         public.leave_requests;
    v_reviewer_id bigint;
begin
    select * into v_req
      from public.leave_requests
     where id = p_request_id;

    if v_req.id is null then
        raise exception 'Leave request not found';
    end if;

    if not public.is_manager_of(v_req.organisation_id) then
        raise exception 'Not authorised to approve leave for this organisation';
    end if;

    if v_req.status <> 'pending' then
        raise exception 'Only pending requests can be approved';
    end if;

    select u.id into v_reviewer_id
      from public.users u
     where u.auth_user_id = auth.uid()
       and u.organisation_id = v_req.organisation_id
     limit 1;

    -- 1. Mark the request approved first so apply_leave_to_timesheet sees
    --    the right state. apply_ raises if any week is locked, which
    --    rolls back this update too.
    update public.leave_requests
       set status               = 'approved',
           reviewed_by          = v_reviewer_id,
           reviewed_at          = now(),
           review_note          = p_note,
           applied_to_timesheet = false,
           updated_at           = now()
     where id = p_request_id;

    -- 2. Apply (raises on locked weeks; sets applied_to_timesheet itself).
    perform public.apply_leave_to_timesheet(p_request_id);
end;
$$;

grant execute on function public.approve_leave_request(bigint, text) to authenticated;

--------------------------------------------------------------------------------
-- D.4 (db side): hours columns must be >= 0
--   Backstop for the client clamp. Client clamps on input event after this
--   migration; this guards against a malicious / programmatic write.
--------------------------------------------------------------------------------

do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'timesheet_entries_hours_nonneg'
    ) then
        alter table public.timesheet_entries
            add constraint timesheet_entries_hours_nonneg
            check (
                mon_hours >= 0 and tue_hours >= 0 and wed_hours >= 0
                and thu_hours >= 0 and fri_hours >= 0 and sat_hours >= 0
                and sun_hours >= 0
            )
            not valid;  -- skip historical rows; new writes are validated
    end if;
end $$;

-- Validate the constraint separately so a single bad legacy row doesn't
-- block deploy. Comment out / re-run as part of a cleanup pass once
-- legacy rows are confirmed clean.
-- alter table public.timesheet_entries validate constraint timesheet_entries_hours_nonneg;
