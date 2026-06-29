-- 124_infusion_export_logs.sql
-- Developer-visible audit trail of every Infusion XLSX export. Records the
-- row count, when the export ran, and which user triggered it. Surfaced
-- only on the developer's view of the Admin → Infusion tab — used to
-- spot anomalies (e.g. row count dropping unexpectedly, which would be
-- the symptom of a silent-truncation regression like the one we just
-- fixed). Past exports done before this migration won't have entries
-- here; they'll just show "no log yet" in the UI.
--
-- One row per export (which may include multiple weeks if the admin
-- re-runs after late submissions for the same week). Re-exports for the
-- same week stack as separate rows so the history is preserved.
--
-- Safe to re-run.

create table if not exists public.infusion_export_logs (
    id              bigserial primary key,
    organisation_id bigint not null
                      references public.organisations (id) on delete cascade,
    week_start      date not null,
    row_count       integer not null,
    exported_at     timestamptz not null default now(),
    exported_by     bigint references public.users (id) on delete set null
);

create index if not exists infusion_export_logs_org_week_idx
    on public.infusion_export_logs (organisation_id, week_start desc);

alter table public.infusion_export_logs enable row level security;

-- Only developers see the audit trail — not regular admins. Writes are
-- gated through the RPC below (no direct insert policy).
drop policy if exists "developers read export logs" on public.infusion_export_logs;
create policy "developers read export logs"
    on public.infusion_export_logs for select
    to authenticated
    using (public.is_developer());

--------------------------------------------------------------------------------
-- log_infusion_export(p_org_id, p_week_start, p_row_count)
--   Called by the Infusion export flow after the XLSX file is written.
--   Admin-level auth — managers don't trigger exports, so the gate matches.
--------------------------------------------------------------------------------

create or replace function public.log_infusion_export(
    p_org_id     bigint,
    p_week_start date,
    p_row_count  integer
)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
    v_user_id bigint;
    v_log_id  bigint;
begin
    if not public.is_admin_of(p_org_id) then
        raise exception 'Not authorised';
    end if;
    if p_row_count is null or p_row_count < 0 then
        raise exception 'row_count must be a non-negative integer';
    end if;

    select id into v_user_id
      from public.users
     where auth_user_id = auth.uid()
       and organisation_id = p_org_id
     limit 1;

    insert into public.infusion_export_logs
        (organisation_id, week_start, row_count, exported_by)
    values
        (p_org_id, p_week_start, p_row_count, v_user_id)
    returning id into v_log_id;

    return v_log_id;
end$$;

grant execute on function public.log_infusion_export(bigint, date, integer) to authenticated;
