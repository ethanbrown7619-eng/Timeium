-- 114_xero_job_leave_mapping.sql
-- The shelved leave_types system (041) isn't used in production — leave
-- is tracked on jobs flagged is_leave=true (036). For Xero integration
-- we map those jobs directly to Xero leave types.
--
-- The leave_types.xero_leave_type_id column added in 112 is left in place
-- (nullable, no references), in case the leave_types system is ever
-- revived.
--
-- Safe to re-run.

alter table public.jobs
    add column if not exists xero_leave_type_id text;

create index if not exists jobs_xero_leave_type_idx
    on public.jobs (xero_leave_type_id)
    where xero_leave_type_id is not null;

--------------------------------------------------------------------------------
-- xero_set_job_leave_type_mapping(p_job_id, p_xero_leave_type_id)
--   Admin-only. Also refuses jobs that aren't flagged is_leave — there's
--   no use case for mapping a non-leave job to a Xero leave type.
--------------------------------------------------------------------------------

create or replace function public.xero_set_job_leave_type_mapping(
    p_job_id             bigint,
    p_xero_leave_type_id text
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    v_org_id   bigint;
    v_is_leave boolean;
begin
    select organisation_id, coalesce(is_leave, false)
      into v_org_id, v_is_leave
      from public.jobs
     where id = p_job_id;
    if v_org_id is null then
        raise exception 'Job not found';
    end if;
    if not public.is_admin_of(v_org_id) then
        raise exception 'Not authorised';
    end if;
    if not v_is_leave then
        raise exception 'Job is not flagged is_leave; refusing to map';
    end if;
    update public.jobs
       set xero_leave_type_id = nullif(trim(p_xero_leave_type_id), '')
     where id = p_job_id;
end$$;

grant execute on function public.xero_set_job_leave_type_mapping(bigint, text) to authenticated;
