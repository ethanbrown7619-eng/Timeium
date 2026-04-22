-- 033_approval_workflow.sql
-- Adds approval_workflow setting to organisations.
-- Two modes:
--   'manager_then_admin' — employees submit to their manager, manager approves then forwards to admin
--   'direct_to_admin'    — all employees submit directly to admin
--
-- Safe to re-run.

alter table public.organisations
    add column if not exists approval_workflow text not null default 'manager_then_admin'
        check (approval_workflow in ('manager_then_admin', 'direct_to_admin'));
