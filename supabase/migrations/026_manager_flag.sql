-- 026_manager_flag.sql
-- Temporium — manager-as-employee-property.
--
-- Adds a simple boolean flag on public.users so the Staff UI can check a
-- "Manager" box on any employee. The Management tab then lets admins drag
-- departments to managers (one manager can manage multiple departments).
--
-- departments.manager_id (from 025) stays unchanged — it still tracks which
-- user manages each department. The new is_manager flag is the prerequisite:
-- only is_manager=true employees show up as available manager columns.
--
-- Backfill: if any departments already have a manager_id set, flag those
-- users as managers.
--
-- Safe to re-run.

alter table public.users
    add column if not exists is_manager boolean not null default false;

update public.users u
    set is_manager = true
    where exists (
        select 1 from public.departments d
        where d.manager_id = u.id
    )
    and not u.is_manager;
