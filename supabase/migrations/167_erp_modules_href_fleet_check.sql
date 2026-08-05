-- 167_erp_modules_href_fleet_check.sql
--
-- Security audit 2026-08-06, finding S1 (destination binding), DB-layer belt.
--
-- The switcher appends a freshly-minted one-time login token to the module's
-- registry `href` and navigates there. The client now validates that href
-- (https + the workers.dev fleet) before ever attaching the token
-- (`ssoDestOk` in shared.js), which fully neutralises a hostile/typo'd row.
-- This constraint adds the SAME rule at the database so such a value cannot
-- even be STORED — defence in depth against a future consumer that forgets
-- to validate, and against a mistaken UPDATE by a developer.
--
-- Allowed: https://<label>.ethanbrown7619.workers.dev  or  .businessautomation.workers.dev,
-- with an optional path (Stock deep-links to /admin, Timesheet to /timesheet).
-- If a custom domain is ever adopted for a module, widen this regex in a new
-- migration BEFORE pointing the registry at it.
--
-- All nine seeded rows already satisfy this (verified against 164's seed and
-- 165's production URL), so ADD CONSTRAINT will not fail on existing data.
-- Idempotent: only adds the constraint if it isn't already present.

do $$
begin
    if not exists (
        select 1 from pg_constraint
         where conrelid = 'public.erp_modules'::regclass
           and conname  = 'erp_modules_href_fleet'
    ) then
        alter table public.erp_modules
            add constraint erp_modules_href_fleet
            check (href ~ '^https://[a-z0-9-]+\.(ethanbrown7619|businessautomation)\.workers\.dev(/.*)?$');
    end if;
end$$;

-- VERIFICATION
--   Should succeed (existing rows already conform):
--     select key, href from public.erp_modules order by sort_order;
--   Should FAIL with a check-constraint violation:
--     update public.erp_modules set href = 'https://evil.example.com' where key = 'map';
