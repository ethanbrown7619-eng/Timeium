-- 105_app_smtp_settings.sql
-- Move SMTP relay credentials out of edge-function env secrets and into
-- the organisations table so admins can manage them through the
-- Configure page without touching Supabase or wrangler.
--
-- The edge function (send-timesheet-notifications) prefers these per-org
-- values when set; otherwise it falls back to the legacy SMTP_*/NOTIFY_FROM
-- env secrets so currently-deployed instances keep sending while you
-- migrate the settings into the UI.
--
-- Credentials are stored in plaintext but the row is gated by RLS — only
-- admins/developers can read/write via the existing organisation policies.
-- Treat the database itself as a secret store, same as you would for any
-- other API key column.

alter table public.organisations
    add column if not exists smtp_host text,
    add column if not exists smtp_port integer,
    add column if not exists smtp_user text,
    add column if not exists smtp_pass text,
    add column if not exists smtp_from text;

update public.organisations
   set smtp_port = 2525
 where smtp_port is null;

-- Extend save_org_settings to accept the new fields. Mirrors the existing
-- pattern from migration 056: coalesce for non-null fields, "case when key
-- present" for fields the admin should be able to clear back to null.
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
           -- 105 SMTP fields. All optional; submitting "" clears them.
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
                                             else smtp_from end
     where id = p_org_id;
end;
$$;

grant execute on function public.save_org_settings(bigint, jsonb) to authenticated;
