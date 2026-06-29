-- 132_unpaid_leave_type.sql
-- Adds "Unpaid Leave" as a leave type. Seeds it for every existing org
-- and folds it into seed_default_leave_types so new orgs get it too.
--
-- Unpaid leave doesn't accrue and has no entitlement — it's purely a
-- category so the request/approval flow and payroll know the leave is
-- unpaid. Like every other type, it still needs mapping to a leave job
-- (Configure > Settings > Leave Type Mapping) before approvals can
-- populate the timesheet.
--
-- Safe to re-run.

insert into public.leave_types
    (organisation_id, code, name, unit, default_entitlement, max_carryover,
     accrues, resets_annually, sort_order)
select o.id, 'UNPAID', 'Unpaid Leave', 'hours', 0, null, false, false, 70
  from public.organisations o
on conflict (organisation_id, code) do nothing;

-- Update the seed function so future orgs include Unpaid Leave.
create or replace function public.seed_default_leave_types(p_org_id bigint)
returns void
language plpgsql security definer set search_path = public
as $$
begin
    insert into public.leave_types
        (organisation_id, code, name, unit, default_entitlement, max_carryover,
         accrues, resets_annually, sort_order)
    values
        (p_org_id, 'ANNUAL',     'Annual Leave',           'hours', 160, null,
         true,  false, 10),
        (p_org_id, 'SICK',       'Sick Leave',             'days',  10,  20,
         true,  false, 20),
        (p_org_id, 'BEREAVEMENT','Bereavement Leave',      'days',  0,   null,
         false, false, 30),
        (p_org_id, 'FAMILY_VIOLENCE','Family Violence Leave','days', 10, 0,
         true,  true,  40),
        (p_org_id, 'ALTERNATIVE','Alternative Day',        'days',  0,   null,
         false, false, 50),
        (p_org_id, 'PUBLIC_HOLIDAY','Public Holiday',      'days',  0,   null,
         false, false, 60),
        (p_org_id, 'UNPAID',     'Unpaid Leave',           'hours', 0,   null,
         false, false, 70)
    on conflict (organisation_id, code) do nothing;
end;
$$;

grant execute on function public.seed_default_leave_types(bigint) to authenticated;
