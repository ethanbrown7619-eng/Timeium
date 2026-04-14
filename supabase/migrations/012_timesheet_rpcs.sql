-- 012_timesheet_rpcs.sql
-- RPCs for the timesheet app. Every employee-callable write function is
-- SECURITY DEFINER and validates auth.uid() against users.auth_user_id.

--------------------------------------------------------------------------------
-- Helpers
--------------------------------------------------------------------------------

-- Is the authenticated user a manager OR admin OR developer?
CREATE OR REPLACE FUNCTION public.is_manager()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.admins
    WHERE user_id = auth.uid()
      AND role IN ('manager', 'admin', 'developer')
  );
$$;

-- Resolve the public.users row for the authenticated session, if any.
CREATE OR REPLACE FUNCTION public.current_employee_id()
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

-- Snap a date to the Monday of its week.
CREATE OR REPLACE FUNCTION public.week_start_of(d date)
RETURNS date
LANGUAGE sql IMMUTABLE
AS $$
  SELECT (d - ((EXTRACT(ISODOW FROM d)::int - 1)))::date;
$$;

--------------------------------------------------------------------------------
-- UPSERT a draft timesheet (client → server sync).
-- Accepts the full week's rows as JSON and rewrites them atomically.
-- Also recomputes regular/overtime split.
--
-- Payload shape (entries):
--   [{
--     "project_id": 123,
--     "task_id": 4,
--     "work_date": "2026-04-14",
--     "hours": 2.5,
--     "note": null
--   }, ...]
--------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.save_timesheet_draft(
  p_week_start date,
  p_entries jsonb,
  p_employee_note text DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id bigint;
  v_submission_id bigint;
  v_week_start date;
  v_ot_threshold numeric(5, 2);
  v_total numeric(6, 2);
  v_ot numeric(6, 2);
BEGIN
  v_user_id := public.current_employee_id();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not signed in as an employee';
  END IF;

  v_week_start := public.week_start_of(p_week_start);

  SELECT COALESCE(u.overtime_threshold_hours, s.overtime_threshold_hours, 40.0)
    INTO v_ot_threshold
    FROM public.users u
    LEFT JOIN public.app_settings s ON s.id = 1
    WHERE u.id = v_user_id;

  -- Upsert the submission shell (cannot modify once submitted).
  INSERT INTO public.timesheet_submissions (user_id, week_start, status, employee_note)
    VALUES (v_user_id, v_week_start, 'draft', p_employee_note)
    ON CONFLICT (user_id, week_start) DO UPDATE
      SET employee_note = EXCLUDED.employee_note,
          updated_at = now()
      WHERE public.timesheet_submissions.status = 'draft'
    RETURNING id INTO v_submission_id;

  IF v_submission_id IS NULL THEN
    -- Conflict row existed but wasn't in draft — block edit.
    RAISE EXCEPTION 'Timesheet for week % is already submitted; cannot edit', v_week_start;
  END IF;

  -- Wipe and reinsert entries.
  DELETE FROM public.timesheet_entries
    WHERE submission_id = v_submission_id AND true;

  INSERT INTO public.timesheet_entries
    (submission_id, project_id, task_id, work_date, hours, note)
  SELECT
    v_submission_id,
    (e->>'project_id')::bigint,
    (e->>'task_id')::bigint,
    (e->>'work_date')::date,
    (e->>'hours')::numeric,
    e->>'note'
  FROM jsonb_array_elements(COALESCE(p_entries, '[]'::jsonb)) AS e
  WHERE (e->>'hours')::numeric > 0
    AND (e->>'work_date')::date BETWEEN v_week_start AND v_week_start + 6;

  -- Flag each entry as overtime if: weekend, holiday, or cumulative-over-threshold.
  WITH ordered AS (
    SELECT te.id, te.work_date, te.hours,
           (EXTRACT(ISODOW FROM te.work_date) IN (6, 7)) AS is_weekend,
           EXISTS (SELECT 1 FROM public.holidays h WHERE h.holiday_date = te.work_date) AS is_holiday,
           SUM(te.hours) OVER (
             ORDER BY te.work_date, te.id
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS running_total
    FROM public.timesheet_entries te
    WHERE te.submission_id = v_submission_id
  )
  UPDATE public.timesheet_entries te
    SET is_overtime = o.is_weekend OR o.is_holiday
      OR (o.running_total > v_ot_threshold)
    FROM ordered o
    WHERE te.id = o.id;

  -- Recompute totals on the submission row.
  SELECT COALESCE(SUM(hours), 0),
         COALESCE(SUM(hours) FILTER (WHERE is_overtime), 0)
    INTO v_total, v_ot
    FROM public.timesheet_entries
    WHERE submission_id = v_submission_id;

  UPDATE public.timesheet_submissions
    SET total_hours = v_total,
        overtime_hours = v_ot,
        regular_hours = GREATEST(v_total - v_ot, 0)
    WHERE id = v_submission_id;

  RETURN v_submission_id;
END$$;

--------------------------------------------------------------------------------
-- SUBMIT timesheet (draft → submitted).
-- Validates that total hours > 0. Front-end is responsible for the "≠40h"
-- warning; the server accepts any positive total and records it.
--------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_timesheet(p_week_start date)
RETURNS timesheet_submissions
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id bigint := public.current_employee_id();
  v_row public.timesheet_submissions;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;

  UPDATE public.timesheet_submissions
    SET status = 'submitted',
        submitted_at = now()
    WHERE user_id = v_user_id
      AND week_start = public.week_start_of(p_week_start)
      AND status IN ('draft', 'rejected')
      AND total_hours > 0
    RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Timesheet not in draft/rejected state or has 0 hours';
  END IF;

  -- Enqueue manager-notification email (outbox pattern).
  INSERT INTO public.pending_notifications (user_id, kind, payload)
    VALUES (
      v_user_id,
      'timesheet_submitted',
      jsonb_build_object(
        'submission_id', v_row.id,
        'week_start', v_row.week_start,
        'total_hours', v_row.total_hours
      )
    );

  RETURN v_row;
END$$;

--------------------------------------------------------------------------------
-- APPROVE / REJECT (manager)
--------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.approve_timesheet(
  p_submission_id bigint,
  p_manager_note text DEFAULT NULL
)
RETURNS timesheet_submissions
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.timesheet_submissions;
  v_manager_id bigint;
BEGIN
  IF NOT public.is_manager() THEN
    RAISE EXCEPTION 'Manager role required';
  END IF;

  SELECT id INTO v_manager_id FROM public.users WHERE auth_user_id = auth.uid();

  UPDATE public.timesheet_submissions
    SET status = 'manager_approved',
        approved_at = now(),
        approved_by = v_manager_id,
        manager_note = p_manager_note
    WHERE id = p_submission_id AND status = 'submitted'
    RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Submission not in "submitted" state';
  END IF;

  INSERT INTO public.pending_notifications (user_id, kind, payload)
    VALUES (
      v_row.user_id,
      'timesheet_approved',
      jsonb_build_object('submission_id', v_row.id, 'week_start', v_row.week_start)
    );

  RETURN v_row;
END$$;

CREATE OR REPLACE FUNCTION public.reject_timesheet(
  p_submission_id bigint,
  p_reason text
)
RETURNS timesheet_submissions
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.timesheet_submissions;
BEGIN
  IF NOT public.is_manager() THEN
    RAISE EXCEPTION 'Manager role required';
  END IF;

  UPDATE public.timesheet_submissions
    SET status = 'rejected',
        rejection_reason = p_reason
    WHERE id = p_submission_id AND status IN ('submitted', 'manager_approved')
    RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Submission not in submitted/approved state';
  END IF;

  INSERT INTO public.pending_notifications (user_id, kind, payload)
    VALUES (
      v_row.user_id,
      'timesheet_rejected',
      jsonb_build_object(
        'submission_id', v_row.id,
        'week_start', v_row.week_start,
        'reason', p_reason
      )
    );

  RETURN v_row;
END$$;

-- Admin reversal: moves any status back to draft. Used when Tina discovers
-- an error after payment, or a manager wants to undo their approval.
CREATE OR REPLACE FUNCTION public.reopen_timesheet(
  p_submission_id bigint,
  p_reason text DEFAULT NULL
)
RETURNS timesheet_submissions
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.timesheet_submissions;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin role required';
  END IF;

  UPDATE public.timesheet_submissions
    SET status = 'draft',
        rejection_reason = p_reason,
        submitted_at = NULL,
        approved_at = NULL,
        approved_by = NULL,
        paid_at = NULL
    WHERE id = p_submission_id
    RETURNING * INTO v_row;

  RETURN v_row;
END$$;

CREATE OR REPLACE FUNCTION public.mark_timesheet_paid(p_submission_id bigint)
RETURNS timesheet_submissions
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.timesheet_submissions;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin role required';
  END IF;

  UPDATE public.timesheet_submissions
    SET status = 'paid', paid_at = now()
    WHERE id = p_submission_id AND status = 'manager_approved'
    RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Submission not in manager_approved state';
  END IF;

  RETURN v_row;
END$$;

--------------------------------------------------------------------------------
-- IMPORT last week: copy the (project, task) tuples from the most recent
-- submitted timesheet into a new draft for p_week_start. Hours are NOT copied —
-- only the row skeleton, so the employee still enters fresh hours.
--------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.import_last_timesheet(p_week_start date)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id bigint := public.current_employee_id();
  v_week date := public.week_start_of(p_week_start);
  v_source_id bigint;
  v_dest_id bigint;
  v_count integer := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;

  -- Most recent prior submission (any status).
  SELECT id INTO v_source_id
  FROM public.timesheet_submissions
  WHERE user_id = v_user_id AND week_start < v_week
  ORDER BY week_start DESC
  LIMIT 1;

  IF v_source_id IS NULL THEN
    RETURN 0;
  END IF;

  -- Upsert destination draft.
  INSERT INTO public.timesheet_submissions (user_id, week_start, status)
    VALUES (v_user_id, v_week, 'draft')
    ON CONFLICT (user_id, week_start) DO UPDATE SET updated_at = now()
    RETURNING id INTO v_dest_id;

  IF v_dest_id IS NULL THEN
    SELECT id INTO v_dest_id FROM public.timesheet_submissions
      WHERE user_id = v_user_id AND week_start = v_week;
  END IF;

  -- Only add (project, task) pairs that aren't already in the destination.
  INSERT INTO public.timesheet_entries
    (submission_id, project_id, task_id, work_date, hours)
  SELECT DISTINCT v_dest_id, e.project_id, e.task_id, v_week, 0
  FROM public.timesheet_entries e
  WHERE e.submission_id = v_source_id
    AND NOT EXISTS (
      SELECT 1 FROM public.timesheet_entries d
      WHERE d.submission_id = v_dest_id
        AND d.project_id = e.project_id
        AND d.task_id = e.task_id
    );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END$$;

--------------------------------------------------------------------------------
-- LOAD a week for editing. Returns:
--   submission row (or NULL-ish shell if none),
--   entries grouped by (project, task) with 7 daily hour columns,
--   clock totals per day for the discrepancy indicator.
--------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.load_timesheet_week(
  p_week_start date,
  p_user_id bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target_user_id bigint;
  v_me bigint := public.current_employee_id();
  v_week date := public.week_start_of(p_week_start);
  v_submission jsonb;
  v_entries jsonb;
  v_clock jsonb;
  v_tz text;
BEGIN
  -- Managers/admins can load anyone; employees only themselves.
  IF p_user_id IS NOT NULL AND p_user_id <> v_me THEN
    IF NOT public.is_manager() THEN
      RAISE EXCEPTION 'Cannot view another employee''s timesheet';
    END IF;
    v_target_user_id := p_user_id;
  ELSE
    v_target_user_id := COALESCE(v_me, p_user_id);
  END IF;

  IF v_target_user_id IS NULL THEN
    RAISE EXCEPTION 'No target user';
  END IF;

  SELECT timezone INTO v_tz FROM public.app_settings WHERE id = 1;

  SELECT to_jsonb(s.*) INTO v_submission
    FROM public.timesheet_submissions s
    WHERE s.user_id = v_target_user_id AND s.week_start = v_week;

  SELECT COALESCE(jsonb_agg(row_to_json(e.*)), '[]'::jsonb) INTO v_entries
    FROM (
      SELECT te.id, te.project_id, te.task_id, te.work_date,
             te.hours, te.is_overtime, te.note,
             p.job_number, p.project_number,
             p.job_description, p.project_description,
             t.name AS task_name
      FROM public.timesheet_entries te
      JOIN public.projects p ON p.id = te.project_id
      JOIN public.tasks t ON t.id = te.task_id
      JOIN public.timesheet_submissions s ON s.id = te.submission_id
      WHERE s.user_id = v_target_user_id AND s.week_start = v_week
      ORDER BY p.job_number, p.project_number, t.name, te.work_date
    ) e;

  -- Clock totals per day from the existing weekly_timesheet RPC.
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'day', wt.day,
      'hours', wt.hours,
      'first_in', wt.first_in,
      'last_out', wt.last_out,
      'flagged', wt.flagged
    )
  ), '[]'::jsonb)
    INTO v_clock
    FROM public.weekly_timesheet(v_week, v_tz) wt
    WHERE wt.user_id = v_target_user_id;

  RETURN jsonb_build_object(
    'week_start', v_week,
    'user_id', v_target_user_id,
    'submission', v_submission,
    'entries', v_entries,
    'clock_hours', v_clock
  );
END$$;

--------------------------------------------------------------------------------
-- MANAGER DASHBOARD: everyone-who-hasn't-submitted-by-deadline
--------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.missing_submissions(p_week_start date)
RETURNS TABLE (
  user_id bigint,
  name text,
  department text,
  manager_id bigint,
  email text,
  status text
)
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    u.id AS user_id,
    u.name,
    u.department,
    u.manager_id,
    u.email,
    COALESCE(s.status, 'missing') AS status
  FROM public.users u
  LEFT JOIN public.timesheet_submissions s
    ON s.user_id = u.id AND s.week_start = public.week_start_of(p_week_start)
  WHERE u.active = true
    AND (s.status IS NULL OR s.status IN ('draft', 'rejected'));
$$;

--------------------------------------------------------------------------------
-- REPORT EXPORTS
-- Infusion: one row per (project, day) with cost hours × cost rate.
-- IMS: one row per (waged user, week) with reg/ot hours.
--------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.infusion_report(
  p_week_start date,
  p_week_end date DEFAULT NULL
)
RETURNS TABLE (
  work_date date,
  job_number text,
  project_number text,
  job_description text,
  user_name text,
  employee_code text,
  task_name text,
  hours numeric,
  is_overtime boolean,
  cost_rate numeric,
  sell_rate numeric,
  cost_amount numeric,
  sell_amount numeric
)
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  WITH window_range AS (
    SELECT public.week_start_of(p_week_start) AS start_d,
           COALESCE(p_week_end, public.week_start_of(p_week_start) + 6) AS end_d
  ),
  rate_at_entry AS (
    SELECT te.id,
      (
        SELECT wrh.cost_rate FROM public.wage_rate_history wrh
        WHERE wrh.user_id = s.user_id AND wrh.effective_from <= te.work_date
        ORDER BY wrh.effective_from DESC LIMIT 1
      ) AS cost_rate,
      (
        SELECT wrh.sell_rate FROM public.wage_rate_history wrh
        WHERE wrh.user_id = s.user_id AND wrh.effective_from <= te.work_date
        ORDER BY wrh.effective_from DESC LIMIT 1
      ) AS sell_rate
    FROM public.timesheet_entries te
    JOIN public.timesheet_submissions s ON s.id = te.submission_id
    JOIN window_range w ON te.work_date BETWEEN w.start_d AND w.end_d
    WHERE s.status IN ('manager_approved', 'paid')
  )
  SELECT
    te.work_date,
    p.job_number,
    p.project_number,
    p.job_description,
    u.name AS user_name,
    u.employee_code,
    t.name AS task_name,
    te.hours,
    te.is_overtime,
    COALESCE(r.cost_rate, u.cost_rate) AS cost_rate,
    COALESCE(r.sell_rate, u.sell_rate) AS sell_rate,
    te.hours * COALESCE(r.cost_rate, u.cost_rate, 0) AS cost_amount,
    te.hours * COALESCE(r.sell_rate, u.sell_rate, 0) AS sell_amount
  FROM public.timesheet_entries te
  JOIN public.timesheet_submissions s ON s.id = te.submission_id
  JOIN public.users u ON u.id = s.user_id
  JOIN public.projects p ON p.id = te.project_id
  JOIN public.tasks t ON t.id = te.task_id
  LEFT JOIN rate_at_entry r ON r.id = te.id
  JOIN window_range w ON te.work_date BETWEEN w.start_d AND w.end_d
  WHERE s.status IN ('manager_approved', 'paid')
  ORDER BY p.job_number, p.project_number, te.work_date, u.name;
$$;

CREATE OR REPLACE FUNCTION public.ims_report(p_week_start date)
RETURNS TABLE (
  employee_code text,
  user_name text,
  department text,
  regular_hours numeric,
  overtime_hours numeric,
  total_hours numeric,
  status text
)
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    u.employee_code,
    u.name,
    u.department,
    s.regular_hours,
    s.overtime_hours,
    s.total_hours,
    s.status
  FROM public.timesheet_submissions s
  JOIN public.users u ON u.id = s.user_id
  WHERE s.week_start = public.week_start_of(p_week_start)
    AND u.employment_type = 'waged'
    AND s.status IN ('manager_approved', 'paid')
  ORDER BY u.name;
$$;

--------------------------------------------------------------------------------
-- PROJECTS SYNC upsert. Called by the Infusion edge function every ~30 min.
-- Security: admin-only.
--------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.upsert_projects_from_infusion(p_projects jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin role required';
  END IF;

  INSERT INTO public.projects (
    job_number, project_number, job_description, job_status,
    project_description, project_status, client_name, active, last_synced_at
  )
  SELECT
    p->>'job_number',
    p->>'project_number',
    p->>'job_description',
    p->>'job_status',
    p->>'project_description',
    p->>'project_status',
    p->>'client_name',
    COALESCE((p->>'active')::boolean, true),
    now()
  FROM jsonb_array_elements(COALESCE(p_projects, '[]'::jsonb)) AS p
  ON CONFLICT (job_number, project_number) DO UPDATE
    SET job_description = EXCLUDED.job_description,
        job_status = EXCLUDED.job_status,
        project_description = EXCLUDED.project_description,
        project_status = EXCLUDED.project_status,
        client_name = EXCLUDED.client_name,
        active = EXCLUDED.active,
        last_synced_at = now(),
        updated_at = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END$$;
