-- 165_timesheet_production_url.sql
--
-- The staff-facing Timesheet is the mirror on the businessautomation
-- Cloudflare account (ptl-timesheet.businessautomation.workers.dev/timesheet),
-- not temporium — temporium remains the dev deployment and the fleet's SSO
-- broker (/sso/mint). Point the registry row at production so the Timesheet
-- switcher and every registry consumer send staff to the right place.
--
-- Matched on the exact previous value, so an operator who has since set a
-- different URL in the registry is not overwritten. Safe to re-run.

update public.erp_modules
   set href       = 'https://ptl-timesheet.businessautomation.workers.dev/timesheet',
       updated_at = now()
 where key  = 'timesheet'
   and href = 'https://temporium.ethanbrown7619.workers.dev';

-- VERIFICATION
--   select key, href from public.erp_modules where key = 'timesheet';
