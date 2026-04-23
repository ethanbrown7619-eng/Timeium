-- 044_force_view_before_approval.sql
-- Org setting: force managers to open a timesheet before they can approve it.
-- Admins are always exempt and can approve inline.
-- Safe to re-run.

alter table public.organisations
    add column if not exists force_view_before_approval boolean not null default false;
