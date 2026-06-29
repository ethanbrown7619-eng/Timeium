-- 131_leave_type_to_job_mapping.sql
-- Invert the leave job ↔ leave type mapping.
--
-- The old model (jobs.leave_type_id, migration 041) made each leave job
-- point to ONE leave type. But PTL has fewer leave jobs than leave types
-- — e.g. "OL — Other Leave" covers both Bereavement and Family Violence.
-- So the relationship is really many leave types → one leave job, which
-- means the FK belongs on leave_types, not jobs.
--
-- This migration:
--   1. Adds leave_types.job_id → jobs(id).
--   2. Backfills it from the existing jobs.leave_type_id links so nothing
--      already mapped is lost.
--   3. Replaces set_job_leave_type_mapping (127) with
--      set_leave_type_job_mapping — admin sets which job a leave type
--      populates.
--   4. Updates approve_leave_request to resolve the job via
--      leave_types.job_id instead of scanning jobs for a matching
--      leave_type_id.
--
-- jobs.leave_type_id is left in place (unused by the new flow) to avoid
-- breaking the Xero mapping or any other reader; can be dropped later.
--
-- Safe to re-run.

alter table public.leave_types
    add column if not exists job_id bigint references public.jobs (id) on delete set null;

create index if not exists leave_types_job_idx
    on public.leave_types (job_id) where job_id is not null;

-- Backfill from the old direction: if a job was linked to a type, point
-- the type back at that job. Many-to-one means the last writer wins if
-- two jobs claimed the same type, but that case shouldn't exist.
update public.leave_types lt
   set job_id = j.id
  from public.jobs j
 where j.leave_type_id = lt.id
   and j.is_leave = true
   and lt.job_id is null;

--------------------------------------------------------------------------------
-- set_leave_type_job_mapping(p_leave_type_id, p_job_id)
--   Admin-only. Links a leave type to the leave job that should be
--   populated on the timesheet when leave of that type is approved.
--------------------------------------------------------------------------------

create or replace function public.set_leave_type_job_mapping(
    p_leave_type_id bigint,
    p_job_id        bigint
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    v_org_id   bigint;
    v_job_org  bigint;
    v_is_leave boolean;
begin
    select organisation_id into v_org_id
      from public.leave_types where id = p_leave_type_id;
    if v_org_id is null then
        raise exception 'Leave type not found';
    end if;
    if not public.is_admin_of(v_org_id) then
        raise exception 'Not authorised';
    end if;

    if p_job_id is not null then
        select organisation_id, coalesce(is_leave, false)
          into v_job_org, v_is_leave
          from public.jobs where id = p_job_id;
        if v_job_org is null then
            raise exception 'Job not found';
        end if;
        if v_job_org <> v_org_id then
            raise exception 'Job belongs to a different organisation';
        end if;
        if not v_is_leave then
            raise exception 'Job is not flagged is_leave; refusing to map';
        end if;
    end if;

    update public.leave_types
       set job_id = p_job_id
     where id = p_leave_type_id;
end$$;

grant execute on function public.set_leave_type_job_mapping(bigint, bigint) to authenticated;

--------------------------------------------------------------------------------
-- approve_leave_request — resolve the leave job via leave_types.job_id.
--   Only change vs migration 129: the v_job_id lookup. Everything else
--   (auth, status guard incl. admin override, timesheet population) is
--   identical.
--------------------------------------------------------------------------------

create or replace function public.approve_leave_request(
    p_request_id bigint,
    p_note text default null
)
returns void
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_req public.leave_requests;
    v_reviewer_id bigint;
    v_job_id bigint;
    v_day date;
    v_week_start date;
    v_ts_id bigint;
    v_entry_id bigint;
    v_dow int;
    v_col text;
begin
    select lr.* into v_req from public.leave_requests lr where lr.id = p_request_id;
    if v_req.id is null then
        raise exception 'Leave request not found';
    end if;
    if not public.is_admin_of(v_req.organisation_id) then
        raise exception 'Not authorised to approve leave for this organisation';
    end if;
    if v_req.status not in ('pending_admin', 'pending_manager') then
        raise exception 'Only a pending request can be approved (current: %)', v_req.status;
    end if;

    select u.id into v_reviewer_id
      from public.users u
     where u.auth_user_id = auth.uid()
       and u.organisation_id = v_req.organisation_id
     limit 1;

    -- Resolve the leave job from the leave type's job_id link.
    select lt.job_id into v_job_id
      from public.leave_types lt
     where lt.id = v_req.leave_type_id;
    if v_job_id is null then
        raise exception 'This leave type is not mapped to a leave job. Map it in Configure > Settings > Leave Type Mapping.';
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
            when 1 then 'mon_hours' when 2 then 'tue_hours' when 3 then 'wed_hours'
            when 4 then 'thu_hours' when 5 then 'fri_hours'
            when 6 then 'sat_hours' when 7 then 'sun_hours'
        end;
        execute format('update public.timesheet_entries set %I = $1 where id = $2', v_col)
          using v_req.hours_per_day, v_entry_id;

        v_day := v_day + 1;
    end loop;

    update public.leave_requests
       set status = 'approved',
           reviewed_by = v_reviewer_id,
           reviewed_at = now(),
           review_note = p_note,
           applied_to_timesheet = true,
           applied_at = now(),
           updated_at = now()
     where id = p_request_id;
end$$;

grant execute on function public.approve_leave_request(bigint, text) to authenticated;
