-- 145_acc_leave_replaces_family_violence.sql
-- Removes "Family Violence Leave" from the selectable leave types and adds
-- "ACC Leave" in its place, for every existing org and for the default
-- seed used by new orgs.
--
-- Family Violence is DEACTIVATED rather than hard-deleted: leave_requests
-- reference leave_type_id with ON DELETE RESTRICT, so any historical
-- request would block a delete. Setting active = false hides it from every
-- request / mapping / balance list (all of which filter active = true)
-- while preserving referential integrity for past records.
--
-- ACC Leave still needs mapping to a leave job (Configure > Settings >
-- Leave Type Mapping) before approvals can populate a timesheet, same as
-- every other type.
--
-- Safe to re-run.

-- 1. Hide Family Violence everywhere it's selectable.
update public.leave_types
   set active = false
 where code = 'FAMILY_VIOLENCE';

-- 2. Add ACC Leave for every existing org (idempotent on the
--    (organisation_id, code) unique key).
insert into public.leave_types
    (organisation_id, code, name, unit, default_entitlement, max_carryover,
     accrues, resets_annually, sort_order)
select o.id, 'ACC', 'ACC Leave', 'hours', 0, null, false, false, 40
  from public.organisations o
on conflict (organisation_id, code) do nothing;

-- Make sure ACC is active (in case a prior run left it disabled).
update public.leave_types
   set active = true
 where code = 'ACC' and active = false;

-- 3. Update the seed so new orgs get ACC and never get Family Violence.
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
        (p_org_id, 'ACC',        'ACC Leave',              'hours', 0,   null,
         false, false, 40),
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
