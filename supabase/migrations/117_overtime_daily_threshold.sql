-- 117_overtime_daily_threshold.sql
-- Per-PTL policy change: overtime is computed daily (any hours above N
-- on a single day = OT for that day) rather than weekly (any hours above
-- weekly threshold = OT lumped on the last weekday). Weekend hours
-- remain all-OT regardless of count.
--
-- New per-employee column overtime_daily_threshold_hours (default 8).
-- The existing weekly column overtime_threshold_hours is left in place
-- but no longer used by OT computation — kept to avoid breaking any
-- ad-hoc query referencing it; can be dropped in a later migration once
-- nothing reads it.
--
-- Safe to re-run.

alter table public.users
    add column if not exists overtime_daily_threshold_hours numeric(4,2) not null default 8.00;
