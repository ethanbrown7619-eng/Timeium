-- 144_clock_view_scope.sql
-- Adds a scope to the Timeclock-viewer permission so a viewer can be
-- limited to the employees in the departments they manage, instead of
-- seeing every clock event in the org.
--
-- can_view_clock_comparison (migration 108) still gates ACCESS to the
-- Timeclock page. This column narrows WHAT a non-admin viewer sees there:
--
--   'all'     -> every employee in the org (the existing behaviour)
--   'managed' -> only employees whose department.manager_id is this user
--
-- Admins / developers always see everything regardless of this value.
-- The restriction is applied in the Timeclock UI (js/timeclock.js); these
-- are trusted internal managers, so it's a display scope, not a hard RLS
-- boundary. Defaulting to 'all' keeps every existing viewer unchanged.
--
-- Safe to re-run.

alter table public.users
    add column if not exists clock_view_scope text not null default 'all';

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'users_clock_view_scope_check'
    ) then
        alter table public.users
            add constraint users_clock_view_scope_check
            check (clock_view_scope in ('all', 'managed'));
    end if;
end$$;
