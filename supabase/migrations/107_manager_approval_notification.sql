-- 107_manager_approval_notification.sql
-- Two additions to public.organisations:
--
-- 1. debug_redirect_email — when set, the edge function reroutes every
--    email it would send (test, preview, scheduled cron) to this address
--    instead of the intended recipient. Subject is prefixed with
--    [DEBUG -> original@addr]. Set this before flipping live toggles
--    so the first scheduled run lands in one inbox you control; clear
--    it once verified.
--
-- 2. Manager-approval notification — a fifth scheduled email, separate
--    from the existing reminder / overdue / discrepancy slots. Goes to
--    each department manager with a per-department roll-up of who
--    submitted (awaiting their approval) and who didn't submit at all.
--    Schedule day/time configurable, single dedup column, default off.

alter table public.organisations
    add column if not exists debug_redirect_email      text,
    add column if not exists notify_manager_approval   boolean not null default false,
    add column if not exists manager_approval_day      text,
    add column if not exists manager_approval_time     time,
    add column if not exists manager_approval_last_sent_at timestamptz;

-- Extend save_org_settings allowlist. Same dynamic-coalesce pattern as
-- 056 / 105, so the Configure page can clear debug_redirect_email by
-- submitting "".
create or replace function public.save_org_settings(
    p_org_id   bigint,
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
           reminder_day_2             = case when p_settings ? 'reminder_day_2'
                                             then nullif(p_settings->>'reminder_day_2', '')
                                             else reminder_day_2 end,
           reminder_time_2            = case when p_settings ? 'reminder_time_2'
                                             then nullif(p_settings->>'reminder_time_2', '')::time
                                             else reminder_time_2 end,
           overdue_day                = coalesce((p_settings->>'overdue_day'),                overdue_day),
           overdue_time               = coalesce((p_settings->>'overdue_time')::time,         overdue_time),
           notify_overdue_recipient   = coalesce((p_settings->>'notify_overdue_recipient'),   notify_overdue_recipient),
           clock_tolerance_hours      = coalesce((p_settings->>'clock_tolerance_hours')::numeric, clock_tolerance_hours),
           notify_discrepancy         = coalesce((p_settings->>'notify_discrepancy')::boolean, notify_discrepancy),
           discrepancy_day            = coalesce((p_settings->>'discrepancy_day'),             discrepancy_day),
           discrepancy_time           = coalesce((p_settings->>'discrepancy_time')::time,      discrepancy_time),
           employment_type_settings   = case when p_settings ? 'employment_type_settings'
                                             then (p_settings->'employment_type_settings')
                                             else employment_type_settings end,
           smtp_host                  = case when p_settings ? 'smtp_host'
                                             then nullif(p_settings->>'smtp_host', '')
                                             else smtp_host end,
           smtp_port                  = case when p_settings ? 'smtp_port'
                                             then nullif(p_settings->>'smtp_port', '')::integer
                                             else smtp_port end,
           smtp_user                  = case when p_settings ? 'smtp_user'
                                             then nullif(p_settings->>'smtp_user', '')
                                             else smtp_user end,
           smtp_pass                  = case when p_settings ? 'smtp_pass'
                                             then nullif(p_settings->>'smtp_pass', '')
                                             else smtp_pass end,
           smtp_from                  = case when p_settings ? 'smtp_from'
                                             then nullif(p_settings->>'smtp_from', '')
                                             else smtp_from end,
           -- 107 fields:
           debug_redirect_email       = case when p_settings ? 'debug_redirect_email'
                                             then nullif(p_settings->>'debug_redirect_email', '')
                                             else debug_redirect_email end,
           notify_manager_approval    = coalesce((p_settings->>'notify_manager_approval')::boolean, notify_manager_approval),
           manager_approval_day       = case when p_settings ? 'manager_approval_day'
                                             then nullif(p_settings->>'manager_approval_day', '')
                                             else manager_approval_day end,
           manager_approval_time      = case when p_settings ? 'manager_approval_time'
                                             then nullif(p_settings->>'manager_approval_time', '')::time
                                             else manager_approval_time end
     where id = p_org_id;
end;
$$;

grant execute on function public.save_org_settings(bigint, jsonb) to authenticated;
