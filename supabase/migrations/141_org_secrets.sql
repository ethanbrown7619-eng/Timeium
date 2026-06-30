-- 141_org_secrets.sql
-- Audit finding C1 (Critical): the organisations table's SELECT policy is
-- `using (true)`, so any authenticated user could read every org's
-- secret-bearing columns — plaintext smtp_pass and the jobs/tasks/
-- dept_codes webhook keys. The webhook keys, once read, let a regular
-- employee call the anon ingest RPCs with the key and overwrite the org's
-- jobs/tasks/dept codes.
--
-- Fix: move the secrets into a dedicated public.org_secrets table whose
-- RLS only lets admins of the org read/write their own row (service_role
-- bypasses for the edge functions; SECURITY DEFINER RPCs for the rest).
-- The old columns on organisations are then NULLed out so nothing
-- sensitive remains readable there. Columns are left in place (not
-- dropped) so any lingering reader degrades to NULL instead of erroring.
--
-- After applying: rotate every smtp_pass and *_webhook_key — treat the
-- old values as disclosed.
--
-- Touchpoints updated here: save_org_settings (smtp writes),
-- rotate_import_key (webhook key writes), the three ingest_*_via_webhook
-- (webhook key lookup). The edge function and configure.js are updated
-- in the same change set to read from org_secrets / the new admin RPC.
--
-- Safe to re-run.

--------------------------------------------------------------------------------
-- org_secrets table
--------------------------------------------------------------------------------

create table if not exists public.org_secrets (
    organisation_id        bigint primary key references public.organisations (id) on delete cascade,
    smtp_host              text,
    smtp_port              integer,
    smtp_user              text,
    smtp_pass              text,
    smtp_from              text,
    debug_redirect_email   text,
    jobs_webhook_key       text,
    tasks_webhook_key      text,
    dept_codes_webhook_key text,
    updated_at             timestamptz not null default now()
);

-- One-time copy of existing secrets from organisations.
insert into public.org_secrets (
    organisation_id, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from,
    debug_redirect_email, jobs_webhook_key, tasks_webhook_key, dept_codes_webhook_key)
select id, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from,
       debug_redirect_email, jobs_webhook_key, tasks_webhook_key, dept_codes_webhook_key
  from public.organisations
on conflict (organisation_id) do nothing;

-- Webhook keys must stay unique for the ingest lookup.
create unique index if not exists org_secrets_jobs_webhook_idx
    on public.org_secrets (jobs_webhook_key) where jobs_webhook_key is not null;
create unique index if not exists org_secrets_tasks_webhook_idx
    on public.org_secrets (tasks_webhook_key) where tasks_webhook_key is not null;
create unique index if not exists org_secrets_dept_webhook_idx
    on public.org_secrets (dept_codes_webhook_key) where dept_codes_webhook_key is not null;

alter table public.org_secrets enable row level security;

-- Admins of the org read/write their own secrets. No grant to anon.
-- service_role bypasses RLS for the edge functions.
revoke all on public.org_secrets from anon;
grant select, insert, update on public.org_secrets to authenticated;
grant all on public.org_secrets to service_role;

drop policy if exists "admins manage org_secrets" on public.org_secrets;
create policy "admins manage org_secrets"
    on public.org_secrets for all
    to authenticated
    using (public.is_admin_of(organisation_id))
    with check (public.is_admin_of(organisation_id));

--------------------------------------------------------------------------------
-- get_org_secrets_admin — admin reads non-password settings + webhook keys
--   for the Configure UI. smtp_pass is deliberately NOT returned (write-only).
--------------------------------------------------------------------------------

create or replace function public.get_org_secrets_admin(p_org_id bigint default null)
returns table (
    smtp_host text, smtp_port integer, smtp_user text, smtp_from text,
    debug_redirect_email text,
    jobs_webhook_key text, tasks_webhook_key text, dept_codes_webhook_key text
)
language plpgsql stable security definer set search_path = public
as $$
declare v_org bigint;
begin
    v_org := public.resolve_org_id(p_org_id);
    if not public.is_admin_of(v_org) then raise exception 'Not authorised'; end if;
    return query
    select s.smtp_host, s.smtp_port, s.smtp_user, s.smtp_from, s.debug_redirect_email,
           s.jobs_webhook_key, s.tasks_webhook_key, s.dept_codes_webhook_key
      from public.org_secrets s where s.organisation_id = v_org;
end$$;

grant execute on function public.get_org_secrets_admin(bigint) to authenticated;

--------------------------------------------------------------------------------
-- save_org_settings — SMTP writes now target org_secrets; the rest of the
-- org settings stay on organisations. Only the changed portion of the
-- function differs from schema-replica; full body re-created here.
--------------------------------------------------------------------------------

create or replace function public.save_org_settings(p_org_id bigint, p_settings jsonb)
returns void language plpgsql security definer set search_path = public as $function$
declare v_org bigint;
begin
    v_org := public.resolve_org_id(p_org_id);
    if not public.is_admin_of(v_org) then raise exception 'not an admin of organisation %', v_org; end if;

    update public.organisations
       set approval_workflow = coalesce((p_settings->>'approval_workflow'), approval_workflow),
           force_view_before_approval = coalesce((p_settings->>'force_view_before_approval')::boolean, force_view_before_approval),
           autofill_public_holidays = coalesce((p_settings->>'autofill_public_holidays')::boolean, autofill_public_holidays),
           public_holiday_hours = coalesce((p_settings->>'public_holiday_hours')::numeric, public_holiday_hours),
           public_holiday_job_id = case when p_settings ? 'public_holiday_job_id' then nullif(p_settings->>'public_holiday_job_id','')::bigint else public_holiday_job_id end,
           deadline_week = coalesce((p_settings->>'deadline_week'), deadline_week),
           deadline_day = coalesce((p_settings->>'deadline_day'), deadline_day),
           deadline_time = coalesce((p_settings->>'deadline_time')::time, deadline_time),
           notify_overdue = coalesce((p_settings->>'notify_overdue')::boolean, notify_overdue),
           notify_reminder = coalesce((p_settings->>'notify_reminder')::boolean, notify_reminder),
           reminder_day = coalesce((p_settings->>'reminder_day'), reminder_day),
           reminder_time = coalesce((p_settings->>'reminder_time')::time, reminder_time),
           reminder_day_2 = case when p_settings ? 'reminder_day_2' then nullif(p_settings->>'reminder_day_2', '') else reminder_day_2 end,
           reminder_time_2 = case when p_settings ? 'reminder_time_2' then nullif(p_settings->>'reminder_time_2', '')::time else reminder_time_2 end,
           overdue_day = coalesce((p_settings->>'overdue_day'), overdue_day),
           overdue_time = coalesce((p_settings->>'overdue_time')::time, overdue_time),
           notify_overdue_recipient = coalesce((p_settings->>'notify_overdue_recipient'), notify_overdue_recipient),
           clock_tolerance_hours = coalesce((p_settings->>'clock_tolerance_hours')::numeric, clock_tolerance_hours),
           notify_discrepancy = coalesce((p_settings->>'notify_discrepancy')::boolean, notify_discrepancy),
           discrepancy_day = coalesce((p_settings->>'discrepancy_day'), discrepancy_day),
           discrepancy_time = coalesce((p_settings->>'discrepancy_time')::time, discrepancy_time),
           employment_type_settings = case when p_settings ? 'employment_type_settings' then (p_settings->'employment_type_settings') else employment_type_settings end,
           notify_manager_approval = coalesce((p_settings->>'notify_manager_approval')::boolean, notify_manager_approval),
           manager_approval_day = case when p_settings ? 'manager_approval_day' then nullif(p_settings->>'manager_approval_day', '') else manager_approval_day end,
           manager_approval_time = case when p_settings ? 'manager_approval_time' then nullif(p_settings->>'manager_approval_time', '')::time else manager_approval_time end
     where id = v_org;

    -- SMTP / debug-redirect secrets live in org_secrets now.
    insert into public.org_secrets (organisation_id) values (v_org)
    on conflict (organisation_id) do nothing;
    update public.org_secrets
       set smtp_host = case when p_settings ? 'smtp_host' then nullif(p_settings->>'smtp_host','') else smtp_host end,
           smtp_port = case when p_settings ? 'smtp_port' then nullif(p_settings->>'smtp_port','')::integer else smtp_port end,
           smtp_user = case when p_settings ? 'smtp_user' then nullif(p_settings->>'smtp_user','') else smtp_user end,
           smtp_pass = case when p_settings ? 'smtp_pass' then nullif(p_settings->>'smtp_pass','') else smtp_pass end,
           smtp_from = case when p_settings ? 'smtp_from' then nullif(p_settings->>'smtp_from','') else smtp_from end,
           debug_redirect_email = case when p_settings ? 'debug_redirect_email' then nullif(p_settings->>'debug_redirect_email','') else debug_redirect_email end,
           updated_at = now()
     where organisation_id = v_org;
end$function$;

--------------------------------------------------------------------------------
-- rotate_import_key — webhook keys now stored in org_secrets.
--------------------------------------------------------------------------------

create or replace function public.rotate_import_key(p_kind text, p_org_id bigint default null)
returns text language plpgsql security definer set search_path = public as $function$
declare v_org bigint; v_key text;
begin
    v_org := public.resolve_org_id(p_org_id);
    if not public.is_admin_of(v_org) then raise exception 'not an admin of organisation %', v_org; end if;
    v_key := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    insert into public.org_secrets (organisation_id) values (v_org) on conflict (organisation_id) do nothing;
    if p_kind = 'jobs' then update public.org_secrets set jobs_webhook_key = v_key, updated_at = now() where organisation_id = v_org;
    elsif p_kind = 'tasks' then update public.org_secrets set tasks_webhook_key = v_key, updated_at = now() where organisation_id = v_org;
    elsif p_kind = 'dept_codes' then update public.org_secrets set dept_codes_webhook_key = v_key, updated_at = now() where organisation_id = v_org;
    else raise exception 'unknown kind: %, expected jobs, tasks, or dept_codes', p_kind;
    end if;
    return v_key;
end$function$;

--------------------------------------------------------------------------------
-- ingest_*_via_webhook — look the org up via org_secrets, import_map still
-- from organisations. Only the lookup line changed.
--------------------------------------------------------------------------------

create or replace function public.ingest_jobs_via_webhook(p_api_key text, p_rows jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $function$
declare v_org bigint; v_map jsonb; v_code_col text; v_desc_col text; v_stat_col text; v_stat_map jsonb; v_count integer := 0;
begin
    if p_api_key is null or length(p_api_key) < 16 then raise exception 'invalid api key'; end if;
    select s.organisation_id, o.jobs_import_map into v_org, v_map
      from public.org_secrets s join public.organisations o on o.id = s.organisation_id
     where s.jobs_webhook_key = p_api_key;
    if v_org is null then raise exception 'unknown api key'; end if;
    v_code_col := coalesce(v_map->>'code_column', 'job_code');
    v_desc_col := coalesce(v_map->>'description_column', 'description');
    v_stat_col := coalesce(v_map->>'status_column', 'status');
    v_stat_map := coalesce(v_map->'status_map', '{}'::jsonb);
    insert into public.jobs (organisation_id, job_code, description, status, source, last_synced_at)
    select distinct on (code) v_org, code, nullif(trim(coalesce(r->>v_desc_col, '')), ''),
        public._canonical_job_status(r->>v_stat_col, v_stat_map), 'webhook', now()
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality as t(r, rn)
    cross join lateral (select trim(r->>v_code_col) as code) c
    where length(coalesce(code, '')) > 0
    order by code, rn desc
    on conflict (organisation_id, job_code) do update
        set description = coalesce(excluded.description, jobs.description),
            status = excluded.status, source = 'webhook', last_synced_at = now(), updated_at = now();
    get diagnostics v_count = row_count;
    return jsonb_build_object('ok', true, 'organisation_id', v_org, 'count', v_count);
end$function$;

create or replace function public.ingest_tasks_via_webhook(p_api_key text, p_rows jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $function$
declare v_org bigint; v_map jsonb; v_code_col text; v_desc_col text; v_stat_col text; v_stat_map jsonb; v_count integer := 0;
begin
    if p_api_key is null or length(p_api_key) < 16 then raise exception 'invalid api key'; end if;
    select s.organisation_id, o.tasks_import_map into v_org, v_map
      from public.org_secrets s join public.organisations o on o.id = s.organisation_id
     where s.tasks_webhook_key = p_api_key;
    if v_org is null then raise exception 'unknown api key'; end if;
    v_code_col := coalesce(v_map->>'code_column', 'task_code');
    v_desc_col := coalesce(v_map->>'description_column', 'description');
    v_stat_col := coalesce(v_map->>'status_column', 'status');
    v_stat_map := coalesce(v_map->'status_map', '{}'::jsonb);
    insert into public.tasks (organisation_id, task_code, description, status, source, last_synced_at)
    select distinct on (code) v_org, code, nullif(trim(coalesce(r->>v_desc_col, '')), ''),
        public._canonical_task_status(r->>v_stat_col, v_stat_map), 'webhook', now()
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality as t(r, rn)
    cross join lateral (select trim(r->>v_code_col) as code) c
    where length(coalesce(code, '')) > 0
    order by code, rn desc
    on conflict (organisation_id, task_code) do update
        set description = coalesce(excluded.description, tasks.description),
            status = excluded.status, source = 'webhook', last_synced_at = now(), updated_at = now();
    get diagnostics v_count = row_count;
    return jsonb_build_object('ok', true, 'organisation_id', v_org, 'count', v_count);
end$function$;

create or replace function public.ingest_dept_codes_via_webhook(p_api_key text, p_rows jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $function$
declare v_org bigint; v_map jsonb; v_code_col text; v_desc_col text; v_stat_col text; v_stat_map jsonb; v_count integer := 0;
begin
    if p_api_key is null or length(p_api_key) < 16 then raise exception 'invalid api key'; end if;
    select s.organisation_id, o.dept_codes_import_map into v_org, v_map
      from public.org_secrets s join public.organisations o on o.id = s.organisation_id
     where s.dept_codes_webhook_key = p_api_key;
    if v_org is null then raise exception 'unknown api key'; end if;
    v_code_col := coalesce(v_map->>'code_column', 'code');
    v_desc_col := coalesce(v_map->>'description_column', 'description');
    v_stat_col := coalesce(v_map->>'status_column', 'status');
    v_stat_map := coalesce(v_map->'status_map', '{}'::jsonb);
    insert into public.department_codes (organisation_id, code, description, status, source, last_synced_at)
    select v_org, trim(r->>v_code_col), nullif(trim(coalesce(r->>v_desc_col, '')), ''),
        public._canonical_dept_code_status(r->>v_stat_col, v_stat_map), 'webhook', now()
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as r
    where length(trim(coalesce(r->>v_code_col, ''))) > 0
    on conflict (organisation_id, code) do update
        set description = excluded.description, status = excluded.status,
            source = 'webhook', last_synced_at = now(), updated_at = now();
    get diagnostics v_count = row_count;
    return jsonb_build_object('ok', true, 'organisation_id', v_org, 'count', v_count);
end$function$;

--------------------------------------------------------------------------------
-- Close the leak: blank the old secret columns on organisations. Columns
-- are left in place so any stale reader gets NULL rather than an error;
-- nothing writes them anymore.
--------------------------------------------------------------------------------

update public.organisations
   set smtp_pass = null, smtp_user = null, smtp_host = null, smtp_port = null,
       smtp_from = null, debug_redirect_email = null,
       jobs_webhook_key = null, tasks_webhook_key = null, dept_codes_webhook_key = null;
