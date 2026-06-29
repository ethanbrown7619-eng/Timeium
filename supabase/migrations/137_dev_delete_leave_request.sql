-- 137_dev_delete_leave_request.sql
-- Developer-only hard delete of a leave request, for clearing out test
-- data. Gated on is_developer() (not just is_admin_of) since it's
-- destructive and bypasses the normal cancel/revoke workflow.
--
-- If the request was approved and had populated the timesheet, the
-- leave hours are zeroed and emptied entries removed first, so deleting
-- the request doesn't leave orphaned leave hours on a timesheet.
--
-- Safe to re-run.

create or replace function public.dev_delete_leave_request(p_request_id bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    v_req public.leave_requests;
    v_job_id bigint;
    v_day date;
    v_week_start date;
    v_ts_id bigint;
    v_entry_id bigint;
    v_dow int;
    v_col text;
begin
    if not public.is_developer() then
        raise exception 'Developer only';
    end if;

    select lr.* into v_req from public.leave_requests lr where lr.id = p_request_id;
    if v_req.id is null then
        raise exception 'Leave request not found';
    end if;

    -- If it was applied to a timesheet, strip the leave hours first.
    if v_req.status = 'approved' and coalesce(v_req.applied_to_timesheet, false) then
        select lt.job_id into v_job_id
          from public.leave_types lt where lt.id = v_req.leave_type_id;
        if v_job_id is not null then
            v_day := v_req.start_date;
            while v_day <= v_req.end_date loop
                v_dow := extract(isodow from v_day)::int;
                if v_req.skip_weekends and v_dow >= 6 then
                    v_day := v_day + 1; continue;
                end if;
                v_week_start := v_day - (v_dow - 1);
                select id into v_ts_id from public.timesheets
                 where user_id = v_req.user_id and week_start = v_week_start limit 1;
                if v_ts_id is not null then
                    select id into v_entry_id from public.timesheet_entries
                     where timesheet_id = v_ts_id and job_id = v_job_id limit 1;
                    if v_entry_id is not null then
                        v_col := case v_dow
                            when 1 then 'mon_hours' when 2 then 'tue_hours' when 3 then 'wed_hours'
                            when 4 then 'thu_hours' when 5 then 'fri_hours'
                            when 6 then 'sat_hours' when 7 then 'sun_hours' end;
                        execute format('update public.timesheet_entries set %I = 0 where id = $1', v_col)
                          using v_entry_id;
                    end if;
                end if;
                v_day := v_day + 1;
            end loop;

            delete from public.timesheet_entries e
             using public.timesheets t
             where e.timesheet_id = t.id
               and t.user_id = v_req.user_id
               and e.job_id = v_job_id
               and coalesce(e.mon_hours,0)+coalesce(e.tue_hours,0)+coalesce(e.wed_hours,0)
                  +coalesce(e.thu_hours,0)+coalesce(e.fri_hours,0)+coalesce(e.sat_hours,0)
                  +coalesce(e.sun_hours,0) = 0;
        end if;
    end if;

    delete from public.leave_requests where id = p_request_id;
end$$;

grant execute on function public.dev_delete_leave_request(bigint) to authenticated;
