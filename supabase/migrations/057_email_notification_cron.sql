-- 057_email_notification_cron.sql
--
-- Schedules the send-timesheet-notifications edge function to fire every
-- 15 minutes via pg_cron + net.http_post. The function itself decides
-- per-org which (if any) of the four notification types to send based on
-- the current local time vs the configured slot.
--
-- IMPORTANT: replace <YOUR-PROJECT-REF> with the Supabase project ref
-- before applying. The url is the public edge function endpoint; the
-- Authorization header carries the service role JWT (already known to
-- pg_cron's session).
--
-- Idempotent: drops the existing schedule by name before re-creating.

-- pg_cron and pg_net are available in Supabase by default but must be
-- enabled. Skip the create-extension calls if your project's database
-- already has them (Supabase Dashboard > Database > Extensions).
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Drop any prior version of this schedule. Comparing by jobname rather
-- than jobid so re-running this migration is safe.
do $$
declare v_jobid bigint;
begin
    select jobid into v_jobid from cron.job where jobname = 'timesheet-notify';
    if v_jobid is not null then
        perform cron.unschedule(v_jobid);
    end if;
end $$;

-- Schedule: every 15 minutes, POST to the edge function. The function
-- short-circuits cheaply if no org has a notification slot matching now,
-- so the cost of running every 15 min is ~one Postgres select.
--
-- Replace the values below before applying:
--   <YOUR-PROJECT-REF>          your Supabase project ref (e.g. kyfydyownbgwhquorchn)
--   <YOUR-SERVICE-ROLE-JWT>     from Supabase Dashboard > Settings > API > service_role
select cron.schedule(
    'timesheet-notify',
    '*/15 * * * *',
    $cron$
        select net.http_post(
            url     := 'https://<YOUR-PROJECT-REF>.supabase.co/functions/v1/send-timesheet-notifications',
            headers := jsonb_build_object(
                'Content-Type',  'application/json',
                'Authorization', 'Bearer <YOUR-SERVICE-ROLE-JWT>'
            ),
            body    := '{}'::jsonb
        ) as request_id;
    $cron$
);
