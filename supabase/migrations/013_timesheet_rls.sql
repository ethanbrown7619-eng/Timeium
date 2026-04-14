-- 013_timesheet_rls.sql
-- RLS policies for the timesheet tables. The pattern mirrors the clock app:
-- employees read/write their own rows via the auth.uid() → users.auth_user_id
-- join, managers read all via is_manager(), admins have full access.

ALTER TABLE public.departments             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.holidays                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wage_rate_history       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timesheet_submissions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timesheet_entries       ENABLE ROW LEVEL SECURITY;

--------------------------------------------------------------------------------
-- Lookup tables (departments, tasks, projects, holidays): read for all signed-in
-- users, write for admins only.
--------------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['departments', 'tasks', 'projects', 'holidays']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_read_all" ON public.%1$s', t);
    EXECUTE format(
      'CREATE POLICY "%1$s_read_all" ON public.%1$s FOR SELECT TO authenticated USING (true)',
      t
    );
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_admin_write" ON public.%1$s', t);
    EXECUTE format(
      'CREATE POLICY "%1$s_admin_write" ON public.%1$s FOR ALL TO authenticated '
      'USING (public.is_admin()) WITH CHECK (public.is_admin())',
      t
    );
  END LOOP;
END$$;

--------------------------------------------------------------------------------
-- wage_rate_history: admins only (sensitive)
--------------------------------------------------------------------------------

DROP POLICY IF EXISTS "wage_rates_admin_all" ON public.wage_rate_history;
CREATE POLICY "wage_rates_admin_all" ON public.wage_rate_history
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

--------------------------------------------------------------------------------
-- timesheet_submissions
--   - Employee can read+insert+update their own draft rows
--   - Manager/admin can read anything
--   - Only admins can delete
--------------------------------------------------------------------------------

DROP POLICY IF EXISTS "ts_submissions_owner_read"    ON public.timesheet_submissions;
DROP POLICY IF EXISTS "ts_submissions_manager_read"  ON public.timesheet_submissions;
DROP POLICY IF EXISTS "ts_submissions_owner_write"   ON public.timesheet_submissions;
DROP POLICY IF EXISTS "ts_submissions_manager_write" ON public.timesheet_submissions;
DROP POLICY IF EXISTS "ts_submissions_admin_delete"  ON public.timesheet_submissions;

CREATE POLICY "ts_submissions_owner_read" ON public.timesheet_submissions
  FOR SELECT TO authenticated
  USING (
    user_id = (SELECT id FROM public.users WHERE auth_user_id = auth.uid())
  );

CREATE POLICY "ts_submissions_manager_read" ON public.timesheet_submissions
  FOR SELECT TO authenticated
  USING (public.is_manager());

-- Insert/update via RLS kept tight; most writes go through SECURITY DEFINER
-- RPCs (save_timesheet_draft, submit_timesheet, etc.) which don't need these
-- policies. The direct-update policy is only for benign fields (e.g. note).
CREATE POLICY "ts_submissions_owner_write" ON public.timesheet_submissions
  FOR UPDATE TO authenticated
  USING (
    user_id = (SELECT id FROM public.users WHERE auth_user_id = auth.uid())
      AND status = 'draft'
  )
  WITH CHECK (status = 'draft');

CREATE POLICY "ts_submissions_manager_write" ON public.timesheet_submissions
  FOR UPDATE TO authenticated
  USING (public.is_manager())
  WITH CHECK (public.is_manager());

CREATE POLICY "ts_submissions_admin_delete" ON public.timesheet_submissions
  FOR DELETE TO authenticated
  USING (public.is_admin());

--------------------------------------------------------------------------------
-- timesheet_entries — inherits ownership via the parent submission.
--------------------------------------------------------------------------------

DROP POLICY IF EXISTS "ts_entries_read"      ON public.timesheet_entries;
DROP POLICY IF EXISTS "ts_entries_owner_write" ON public.timesheet_entries;
DROP POLICY IF EXISTS "ts_entries_admin_all" ON public.timesheet_entries;

CREATE POLICY "ts_entries_read" ON public.timesheet_entries
  FOR SELECT TO authenticated
  USING (
    public.is_manager()
    OR EXISTS (
      SELECT 1 FROM public.timesheet_submissions s
      JOIN public.users u ON u.id = s.user_id
      WHERE s.id = timesheet_entries.submission_id
        AND u.auth_user_id = auth.uid()
    )
  );

-- Direct insert/update/delete are only allowed on draft rows owned by the
-- caller. Most writes still go through save_timesheet_draft.
CREATE POLICY "ts_entries_owner_write" ON public.timesheet_entries
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.timesheet_submissions s
      JOIN public.users u ON u.id = s.user_id
      WHERE s.id = timesheet_entries.submission_id
        AND u.auth_user_id = auth.uid()
        AND s.status = 'draft'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.timesheet_submissions s
      JOIN public.users u ON u.id = s.user_id
      WHERE s.id = timesheet_entries.submission_id
        AND u.auth_user_id = auth.uid()
        AND s.status = 'draft'
    )
  );

CREATE POLICY "ts_entries_admin_all" ON public.timesheet_entries
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

--------------------------------------------------------------------------------
-- Users table: extend existing RLS so employees can read their own row
-- (name, rates, etc. for the header display) without needing admin.
--------------------------------------------------------------------------------

DROP POLICY IF EXISTS "users_self_read" ON public.users;
CREATE POLICY "users_self_read" ON public.users
  FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid() OR public.is_manager());
