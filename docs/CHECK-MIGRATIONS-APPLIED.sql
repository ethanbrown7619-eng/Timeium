-- Which Timesheet migrations are actually live?
--
-- Nothing in this database records applied migrations — they're pasted into
-- the SQL editor by hand and leave no trace. So this fingerprints the schema
-- instead: each row probes for an object, column, constraint or a distinctive
-- line of function source that ONLY that migration creates.
--
-- Read-only. Safe to run on production.
--
-- Caveat: a "yes" means the fingerprint is present, which is strong evidence
-- but not proof the whole file ran — a migration that failed halfway could
-- still show yes. A "NO" is reliable.

with fn as (
    select p.proname, p.prosrc
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
)
select migration,
       case when applied is null then 'n/a'
            when applied        then 'yes'
            else 'NO  <-- not applied' end as status,
       probe
  from (values
    ('138_leave_amendment_values',        exists(select 1 from fn where proname = 'apply_leave_amendment'),                          'fn apply_leave_amendment'),
    ('139_login_attempt_hardening',       exists(select 1 from fn where proname = 'record_login_success'),                           'fn record_login_success'),
    ('140_random_temp_passwords',         exists(select 1 from fn where proname = 'gen_temp_password'),                              'fn gen_temp_password'),
    ('141_org_secrets',                   exists(select 1 from fn where proname = 'get_org_secrets_admin'),                          'fn get_org_secrets_admin'),
    ('142_password_verification_hook',    exists(select 1 from fn where proname = 'password_verification_hook'),                     'fn password_verification_hook'),
    ('143_xero_oauth_used_states',        to_regclass('public.xero_oauth_used_states') is not null,                                  'table xero_oauth_used_states'),
    ('144_clock_view_scope',              exists(select 1 from information_schema.columns
                                                  where table_schema = 'public' and table_name = 'users'
                                                    and column_name = 'clock_view_scope'),                                           'users.clock_view_scope'),
    ('145_acc_leave_replaces_fam_viol',   exists(select 1 from fn where proname = 'seed_default_leave_types' and prosrc like '%ACC%'), 'ACC in seed_default_leave_types'),
    ('146_clock_adjustment_requests',     to_regclass('public.clock_adjustment_requests') is not null,                               'table clock_adjustment_requests'),
    ('147_my_offsite_spells',             exists(select 1 from fn where proname = 'list_my_offsite_spells'),                         'fn list_my_offsite_spells'),
    ('148_require_department_on_submit',  exists(select 1 from pg_trigger
                                                  where tgname = 'trg_timesheet_require_department' and not tgisinternal),            'trigger trg_timesheet_require_department'),
    ('149_clock_reports_use_dept_id',     exists(select 1 from fn where proname = '_offsite_report'),                                'fn _offsite_report'),
    ('150_manager_final_leave_approval',  exists(select 1 from fn where proname = 'list_managed_employees'),                         'fn list_managed_employees'),
    -- 159 moved the real body into _offsite_report_impl and left a wrapper
    -- behind the public name, so this has to match either.
    ('151_fix_false_clock_out_early',     exists(select 1 from fn where proname like '\_offsite\_report%'
                                                   and prosrc like '%20 minutes%'),                                                  'the 20-minute grace in _offsite_report(_impl)'),
    ('152_manager_leave_change_requests', exists(select 1 from fn where proname = 'dismiss_leave_change_request'),                    'fn dismiss_leave_change_request'),
    ('153_record_scan_early_leave_window', null::boolean,                                                                             'nothing to probe - the file is a no-op (select 1)'),
    ('155_edit_pending_on_behalf_leave',  exists(select 1 from fn where proname = 'update_pending_leave_request'),                    'fn update_pending_leave_request'),
    ('156_org_leave_calendar',            exists(select 1 from fn where proname = 'org_leave_calendar'),                              'fn org_leave_calendar'),
    ('157_dismiss_my_leave_requests',     exists(select 1 from fn where proname = 'dismiss_my_leave_request'),                        'fn dismiss_my_leave_request'),
    ('158_leave_email_notifications',     to_regclass('public.leave_notification_queue') is not null,                                'table leave_notification_queue'),
    ('159_gate_clock_report_rpcs',        exists(select 1 from fn where proname = 'org_live_status'
                                                   and prosrc like '%not authorised%'),                                              'auth gate inside org_live_status'),
    ('160_narrow_manager_read_scope',     exists(select 1 from fn where proname = 'clock_roster'),                                    'fn clock_roster'),
    -- 161 REPLACES the broad "read organisations" policy with this narrower
    -- one, so the new name present (and the old one gone) is the fingerprint.
    ('161_scope_organisations_read',      exists(select 1 from pg_policies
                                                  where schemaname = 'public' and tablename = 'organisations'
                                                    and policyname = 'members read own organisation'),                               'policy "members read own organisation"'),
    ('162_restore_login_audit_trail',     exists(select 1 from fn where proname = 'prune_login_attempts'),                            'fn prune_login_attempts'),
    ('163_provision_login_link_guard',    exists(select 1 from fn where proname = 'provision_employee_login'
                                                   and prosrc like '%v_claimed_by%'),                                                'the claimed-by guard'),
    ('164_module_access',                 exists(select 1 from fn where proname = 'list_module_access_matrix'),                       'fn list_module_access_matrix'),
    ('165_timesheet_production_url',      exists(select 1 from public.erp_modules
                                                  where key = 'timesheet' and href like '%ptl-timesheet%'),                           'timesheet module href'),
    ('166_module_access_respect_active',  exists(select 1 from fn where proname = 'module_access_granted'
                                                   and prosrc like '%active%'),                                                      'active checks in module_access_granted'),
    ('167_erp_modules_href_fleet_check',  exists(select 1 from pg_constraint where conname = 'erp_modules_href_fleet'),                'constraint erp_modules_href_fleet'),
    ('168_leave_only_via_request',        exists(select 1 from fn where proname = 'import_last_week_tasks'
                                                   and prosrc like '%is_leave%'),                                                    'leave filter in import_last_week_tasks'),
    -- Deliberately the dumbest possible probe: a column either exists or it
    -- doesn't. Probes that pattern-match a function body have twice caught me
    -- out when a later migration moved the body somewhere else.
    ('169_jobs_customer_dates_type',      exists(select 1 from information_schema.columns
                                                  where table_schema = 'public' and table_name = 'jobs'
                                                    and column_name = 'customer_name'),                                              'column jobs.customer_name'),
    ('170_parse_excel_serial_dates',      exists(select 1 from fn where proname = '_parse_infusion_date'
                                                   and prosrc like '%1899-12-30%'),                                                  'Excel epoch in _parse_infusion_date')
  ) as t(migration, applied, probe)
 order by migration;
