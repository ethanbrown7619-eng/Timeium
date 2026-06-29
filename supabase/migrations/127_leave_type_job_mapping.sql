-- 127_leave_type_job_mapping.sql
-- Admin-only RPC to link a leave-flagged job (jobs.is_leave=true) to one
-- of the seeded leave_types rows. The link is what the
-- approve_leave_request RPC walks to know which job to populate on the
-- timesheet when an admin signs off — without it, the approval throws
-- "No leave job configured for this leave type".
--
-- Mirrors the xero_set_job_leave_type_mapping RPC from migration 114
-- (which links the same jobs to Xero leave types) — same shape, same
-- guards, different column.
--
-- Safe to re-run.

create or replace function public.set_job_leave_type_mapping(
    p_job_id        bigint,
    p_leave_type_id bigint
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    v_org_id   bigint;
    v_is_leave boolean;
    v_lt_org   bigint;
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

    -- Allow clearing (p_leave_type_id null), otherwise validate the leave
    -- type belongs to the same org.
    if p_leave_type_id is not null then
        select organisation_id into v_lt_org
          from public.leave_types
         where id = p_leave_type_id;
        if v_lt_org is null then
            raise exception 'Leave type not found';
        end if;
        if v_lt_org <> v_org_id then
            raise exception 'Leave type belongs to a different organisation';
        end if;
    end if;

    update public.jobs
       set leave_type_id = p_leave_type_id
     where id = p_job_id;
end$$;

grant execute on function public.set_job_leave_type_mapping(bigint, bigint) to authenticated;
