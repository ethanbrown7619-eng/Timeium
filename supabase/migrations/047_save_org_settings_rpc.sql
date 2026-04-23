-- 047_save_org_settings_rpc.sql
-- SECURITY DEFINER RPC to update organisation settings.
-- The organisations table is owned by the shared Attendium core and may have
-- RLS policies that block direct UPDATE from authenticated users.
-- Safe to re-run.

create or replace function public.save_org_settings(
    p_org_id bigint,
    p_settings jsonb
)
returns void
language plpgsql security definer set search_path = public
as $$
begin
    if not public.is_admin_of(p_org_id) then
        raise exception 'Not an admin of this organisation';
    end if;

    update public.organisations
       set approval_workflow          = coalesce((p_settings->>'approval_workflow'),          approval_workflow),
           force_view_before_approval = coalesce((p_settings->>'force_view_before_approval')::boolean, force_view_before_approval),
           autofill_public_holidays   = coalesce((p_settings->>'autofill_public_holidays')::boolean,   autofill_public_holidays),
           public_holiday_hours       = coalesce((p_settings->>'public_holiday_hours')::numeric,       public_holiday_hours),
           public_holiday_job_id      = case when p_settings ? 'public_holiday_job_id'
                                             then (p_settings->>'public_holiday_job_id')::bigint
                                             else public_holiday_job_id end,
           deadline_week              = coalesce((p_settings->>'deadline_week'),              deadline_week),
           deadline_day               = coalesce((p_settings->>'deadline_day'),               deadline_day),
           deadline_time              = coalesce((p_settings->>'deadline_time')::time,        deadline_time),
           notify_overdue             = coalesce((p_settings->>'notify_overdue')::boolean,    notify_overdue),
           notify_reminder            = coalesce((p_settings->>'notify_reminder')::boolean,   notify_reminder),
           reminder_day               = coalesce((p_settings->>'reminder_day'),               reminder_day),
           reminder_time              = coalesce((p_settings->>'reminder_time')::time,        reminder_time),
           clock_tolerance_hours      = coalesce((p_settings->>'clock_tolerance_hours')::numeric, clock_tolerance_hours),
           notify_discrepancy         = coalesce((p_settings->>'notify_discrepancy')::boolean, notify_discrepancy),
           discrepancy_day            = coalesce((p_settings->>'discrepancy_day'),            discrepancy_day),
           discrepancy_time           = coalesce((p_settings->>'discrepancy_time')::time,     discrepancy_time)
     where id = p_org_id;
end;
$$;

grant execute on function public.save_org_settings(bigint, jsonb) to authenticated;
