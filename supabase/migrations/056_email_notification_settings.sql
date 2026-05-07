-- 056_email_notification_settings.sql
--
-- Adds the per-org configuration columns the new send-timesheet-notifications
-- edge function (separate repo, shared Supabase project) reads to decide
-- when, who, and what to email. Idempotent.
--
-- Columns added on public.organisations:
--   reminder_day_2 / reminder_time_2     - second weekly reminder slot (both
--                                          nullable; null means second slot
--                                          disabled). Pairs with the existing
--                                          reminder_day / reminder_time from
--                                          migration 034.
--   overdue_day    / overdue_time        - when the post-deadline "still
--                                          overdue" digest fires. Defaults
--                                          to Tuesday 09:00 (one day after
--                                          the typical Monday 08:00 deadline).
--   notify_overdue_recipient             - 'employee' | 'admins' | 'both'.
--                                          Drives who gets the overdue email.
--   reminder_last_sent_at                - dedup so cron firing twice in the
--   reminder_2_last_sent_at                same configured slot doesn't
--   overdue_last_sent_at                   double-send. Compared against
--   discrepancy_last_sent_at               localDate(tz, last_sent_at).
--
-- Updates save_org_settings allowlist so admins can set them via the
-- Configure page. Doesn't touch RLS (organisations writes are already
-- admin-only via the existing policies on that table).

alter table public.organisations
    add column if not exists reminder_day_2 text
        check (reminder_day_2 is null or
               reminder_day_2 in ('monday','tuesday','wednesday','thursday','friday','saturday','sunday'));

alter table public.organisations
    add column if not exists reminder_time_2 time;

alter table public.organisations
    add column if not exists overdue_day text not null default 'tuesday'
        check (overdue_day in ('monday','tuesday','wednesday','thursday','friday','saturday','sunday'));

alter table public.organisations
    add column if not exists overdue_time time not null default '09:00';

alter table public.organisations
    add column if not exists notify_overdue_recipient text not null default 'employee'
        check (notify_overdue_recipient in ('employee','admins','both'));

alter table public.organisations
    add column if not exists reminder_last_sent_at    timestamptz;

alter table public.organisations
    add column if not exists reminder_2_last_sent_at  timestamptz;

alter table public.organisations
    add column if not exists overdue_last_sent_at     timestamptz;

alter table public.organisations
    add column if not exists discrepancy_last_sent_at timestamptz;

--------------------------------------------------------------------------------
-- save_org_settings: allowlist extended with the new fields. Mirrors 050's
-- pattern (coalesce for non-null fields, "case when key present" for fields
-- the admin should be able to clear back to null).
--------------------------------------------------------------------------------

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
           -- 056 fields:
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
                                             else employment_type_settings end
     where id = p_org_id;
end;
$$;

grant execute on function public.save_org_settings(bigint, jsonb) to authenticated;
