-- 011_timesheet_schema.sql
-- Timesheet Web App (Phase 2) schema.
--
-- Builds on the existing clock-app tables (public.users, public.app_settings,
-- public.clock_events, public.admins). Extends public.users and public.admins
-- with columns the timesheet flow needs, then adds new tables:
--   departments, tasks, projects, holidays,
--   wage_rate_history,
--   timesheet_submissions, timesheet_entries.
--
-- Safe to re-run.

--------------------------------------------------------------------------------
-- USERS: extend with manager + rate columns
--------------------------------------------------------------------------------

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS manager_id bigint
    REFERENCES public.users (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS auth_user_id uuid UNIQUE
    REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS employment_type text
    CHECK (employment_type IN ('waged', 'salaried', 'contractor'))
    DEFAULT 'waged',
  ADD COLUMN IF NOT EXISTS overtime_threshold_hours numeric(5, 2)
    DEFAULT 40.0;

CREATE INDEX IF NOT EXISTS users_manager_id_idx ON public.users (manager_id);
CREATE INDEX IF NOT EXISTS users_auth_user_id_idx ON public.users (auth_user_id);

--------------------------------------------------------------------------------
-- ADMINS: add 'manager' role option (admin | manager | developer, superset order)
--------------------------------------------------------------------------------

-- Existing check constraint assumes admin|developer. Drop and recreate to allow manager.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'admins_role_check' AND conrelid = 'public.admins'::regclass
  ) THEN
    ALTER TABLE public.admins DROP CONSTRAINT admins_role_check;
  END IF;
END$$;

ALTER TABLE public.admins
  ADD CONSTRAINT admins_role_check
  CHECK (role IN ('admin', 'manager', 'developer'));

-- Tina's "payroll" role reuses admin — she sees all approved timesheets and
-- runs the IMS / Infusion report exports. No separate payroll role for now.

--------------------------------------------------------------------------------
-- APP_SETTINGS: add timesheet-specific config
--------------------------------------------------------------------------------

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS week_start_dow smallint DEFAULT 1, -- 1=Monday
  ADD COLUMN IF NOT EXISTS overtime_threshold_hours numeric(5, 2) DEFAULT 40.0,
  ADD COLUMN IF NOT EXISTS submission_deadline_dow smallint DEFAULT 1, -- Monday
  ADD COLUMN IF NOT EXISTS submission_deadline_hour smallint DEFAULT 8,
  ADD COLUMN IF NOT EXISTS reminder_enabled boolean DEFAULT true;

--------------------------------------------------------------------------------
-- DEPARTMENTS (dropdown list)
--------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.departments (
  id bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

--------------------------------------------------------------------------------
-- TASKS (dropdown list; global, not per-project for v1)
--------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tasks (
  id bigserial PRIMARY KEY,
  code text UNIQUE,
  name text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

--------------------------------------------------------------------------------
-- PROJECTS (synced from Infusion every ~30 min)
-- One row per (job_number, project_number). Job-level detail replicated on
-- every project row because Infusion's project endpoint already denormalises
-- it; querying a single table keeps the UI simple.
--------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.projects (
  id bigserial PRIMARY KEY,
  job_number text NOT NULL,
  project_number text NOT NULL,
  job_description text,
  job_status text,
  project_description text,
  project_status text,
  client_name text,
  active boolean NOT NULL DEFAULT true,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_number, project_number)
);

CREATE INDEX IF NOT EXISTS projects_active_idx ON public.projects (active);
CREATE INDEX IF NOT EXISTS projects_job_number_idx ON public.projects (job_number);

--------------------------------------------------------------------------------
-- HOLIDAYS (hours on holidays count as overtime)
--------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.holidays (
  id bigserial PRIMARY KEY,
  holiday_date date NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

--------------------------------------------------------------------------------
-- WAGE RATE HISTORY
-- Rates nominally change 2x/year but are not restricted to that cadence.
-- We store the history with effective_from so report exports can re-price
-- historical timesheets against the rate that was live at submission time.
--------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.wage_rate_history (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  cost_rate numeric(10, 2),
  sell_rate numeric(10, 2),
  effective_from date NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users (id)
);

CREATE INDEX IF NOT EXISTS wage_rate_history_user_date_idx
  ON public.wage_rate_history (user_id, effective_from DESC);

--------------------------------------------------------------------------------
-- TIMESHEET SUBMISSIONS
-- One row per (user, week_start). Lifecycle:
--   draft  →  submitted  →  manager_approved  →  paid
--   draft  →  rejected  (from manager_approved or submitted)
--------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.timesheet_submissions (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  week_start date NOT NULL,                  -- Monday of the week
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'manager_approved', 'rejected', 'paid')),
  total_hours numeric(6, 2) NOT NULL DEFAULT 0,
  regular_hours numeric(6, 2) NOT NULL DEFAULT 0,
  overtime_hours numeric(6, 2) NOT NULL DEFAULT 0,
  submitted_at timestamptz,
  approved_at timestamptz,
  approved_by bigint REFERENCES public.users (id),
  paid_at timestamptz,
  rejection_reason text,
  employee_note text,
  manager_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, week_start)
);

CREATE INDEX IF NOT EXISTS timesheet_submissions_status_idx
  ON public.timesheet_submissions (status);
CREATE INDEX IF NOT EXISTS timesheet_submissions_week_idx
  ON public.timesheet_submissions (week_start);

--------------------------------------------------------------------------------
-- TIMESHEET ENTRIES
-- One row per (submission, project, task, day). Hours cannot exist without
-- a project (job + project number) and task — enforced by NOT NULL FKs.
--------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.timesheet_entries (
  id bigserial PRIMARY KEY,
  submission_id bigint NOT NULL
    REFERENCES public.timesheet_submissions (id) ON DELETE CASCADE,
  project_id bigint NOT NULL REFERENCES public.projects (id),
  task_id bigint NOT NULL REFERENCES public.tasks (id),
  work_date date NOT NULL,
  hours numeric(5, 2) NOT NULL CHECK (hours >= 0 AND hours <= 24),
  is_overtime boolean NOT NULL DEFAULT false,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS timesheet_entries_submission_idx
  ON public.timesheet_entries (submission_id);
CREATE INDEX IF NOT EXISTS timesheet_entries_project_date_idx
  ON public.timesheet_entries (project_id, work_date);

--------------------------------------------------------------------------------
-- updated_at triggers (reuse existing helper if it exists)
--------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS trg_projects_updated_at ON public.projects;
CREATE TRIGGER trg_projects_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_timesheet_submissions_updated_at
  ON public.timesheet_submissions;
CREATE TRIGGER trg_timesheet_submissions_updated_at
  BEFORE UPDATE ON public.timesheet_submissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
