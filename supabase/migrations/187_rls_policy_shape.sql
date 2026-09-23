-- ============================================================================
-- 187_rls_policy_shape.sql (Timeium)
-- SQL efficiency audit 2026-09-24, lane L1, reviewed 2026-09-24.
-- Independent of the ptl-purchase-orders files; apply any time.
--
-- WHY. The Timesheet-owned public.* tables that PO/Spares and bom-import also
-- read (jobs, quotes, quote_lines, invoices, departments, organisations,
-- projects, tasks, leave_types, public_holidays) gate SELECT with
--   is_admin_of(organisation_id) OR EXISTS(...users...) OR EXISTS(...admins...)
-- The two EXISTS already plan as hashed SubPlans, but is_admin_of() is a
-- SECURITY DEFINER SQL function with SET search_path (never inlined) and
-- sits FIRST in the OR - it runs once per row. Production: the Timesheet
-- jobs dropdown (SELECT ... FROM jobs WHERE organisation_id=$1 ORDER BY
-- job_code) ran 1,375 times in 5.9 days at 91 ms mean / 6,153 buffers for
-- 6,759 rows.
--
-- WHAT. In every one of these 16 policies the is_admin_of(x) call is
-- replaced, in place, by the exact set the function's own SQL computes:
--   x IN (SELECT a.organisation_id FROM admins a WHERE a.user_id = (SELECT auth.uid()))
--   OR (SELECT public.is_developer())
-- (the same identity and NULL-org proof as ptl-purchase-orders 119). Every
-- other clause is byte-for-byte as production has it. The admins subquery
-- now runs as the invoker under admins' own RLS; "admins read admins" makes
-- a user's own rows visible unconditionally (checked on production's current
-- policies 2026-09-24), so the check always sees what it needs.
--
-- MEASURED (Tokyo, production text, real member JWT, rolled back; reviewer
-- re-verified): jobs dropdown 132 ms / 9,738 buffers -> 6 ms / 2,981 buffers
-- (~22x). Fingerprints identical for a developer, an org admin, a plain
-- member and anon across all 10 tables (0 mismatches).
--
-- GUARD. One transaction. Fingerprints (md5 of the visible keys) every
-- touched table as THREE identities - production's developer account, the
-- lowest-id active non-admin member whose auth row matches, and anon -
-- before and after; RAISEs (rolling back) on any difference. Idempotent.
-- ASCII-only. ALTER POLICY takes a brief AccessExclusive lock on 10 tables
-- read by every Timesheet page - pick a quiet moment.
-- ============================================================================

begin;
set local statement_timeout = '3min';
set local lock_timeout = '10s';

create temp table _who_187 on commit drop as
select 'developer'::text as who, 'authenticated'::text as rol, au.id as sub, au.email::text as email
  from auth.users au
 where lower(au.email) = lower('ethan.brown@ptlmachinery.com')
union all
select 'member', 'authenticated', x.sub, x.email
  from (select au.id as sub, au.email::text as email
          from public.users u
          join auth.users au on au.id = u.auth_user_id and lower(au.email) = lower(u.email)
         where u.auth_user_id is not null
           and coalesce(u.active, true)
           and not exists (select 1 from public.admins a where a.user_id = u.auth_user_id)
         order by u.id
         limit 1) x
union all
select 'anon', 'anon', null::uuid, null::text;

create or replace function pg_temp.fp187(p_who text, p_rol text, p_sub uuid, p_email text) returns table (what text, val text)
language plpgsql as $fp$
begin
  if p_rol = 'anon' then
    perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
    set local role anon;
  else
    perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'email', p_email, 'role', 'authenticated')::text, true);
    set local role authenticated;
  end if;
  what := p_who || ':jobs';              select md5(coalesce(string_agg(id::text, ',' order by id), '')) into val from public.jobs; return next;
  what := p_who || ':quotes';            select md5(coalesce(string_agg(concat_ws(':', organisation_id, quote_no), ',' order by concat_ws(':', organisation_id, quote_no)), '')) into val from public.quotes; return next;
  what := p_who || ':quote_lines';       select md5(coalesce(string_agg(id::text, ',' order by id), '')) into val from public.quote_lines; return next;
  what := p_who || ':invoices';          select md5(coalesce(string_agg(concat_ws(':', organisation_id, invoice_no), ',' order by concat_ws(':', organisation_id, invoice_no)), '')) into val from public.invoices; return next;
  what := p_who || ':departments';       select md5(coalesce(string_agg(id::text, ',' order by id), '')) into val from public.departments; return next;
  what := p_who || ':organisations';     select md5(coalesce(string_agg(id::text, ',' order by id), '')) into val from public.organisations; return next;
  what := p_who || ':projects';          select md5(coalesce(string_agg(id::text, ',' order by id), '')) into val from public.projects; return next;
  what := p_who || ':tasks';             select md5(coalesce(string_agg(id::text, ',' order by id), '')) into val from public.tasks; return next;
  what := p_who || ':leave_types';       select md5(coalesce(string_agg(id::text, ',' order by id), '')) into val from public.leave_types; return next;
  what := p_who || ':public_holidays';   select md5(coalesce(string_agg(id::text, ',' order by id), '')) into val from public.public_holidays; return next;
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $fp$;

create temp table _before_187 on commit drop as
  select f.* from _who_187 w, lateral pg_temp.fp187(w.who, w.rol, w.sub, w.email) f;

-- ---------------------------------------------------------------- policies --
ALTER POLICY "admins manage org departments" ON public.departments
USING (
  organisation_id IN (SELECT a.organisation_id FROM admins a WHERE a.user_id = (SELECT auth.uid()))
  OR (SELECT public.is_developer())
)
WITH CHECK (
  organisation_id IN (SELECT a.organisation_id FROM admins a WHERE a.user_id = (SELECT auth.uid()))
  OR (SELECT public.is_developer())
);

ALTER POLICY "members read org departments" ON public.departments USING (
  (organisation_id IN (SELECT a.organisation_id FROM admins a WHERE a.user_id = (SELECT auth.uid())) OR (SELECT public.is_developer()))
  OR (EXISTS ( SELECT 1 FROM users u WHERE ((u.auth_user_id = (SELECT auth.uid())) AND (u.organisation_id = departments.organisation_id))))
  OR (EXISTS ( SELECT 1 FROM admins a WHERE ((a.user_id = (SELECT auth.uid())) AND (a.organisation_id = departments.organisation_id))))
);

ALTER POLICY "members read org invoices" ON public.invoices USING (
  (organisation_id IN (SELECT a.organisation_id FROM admins a WHERE a.user_id = (SELECT auth.uid())) OR (SELECT public.is_developer()))
  OR (EXISTS ( SELECT 1 FROM users u WHERE ((u.auth_user_id = (SELECT auth.uid())) AND (u.organisation_id = invoices.organisation_id))))
  OR (EXISTS ( SELECT 1 FROM admins a WHERE ((a.user_id = (SELECT auth.uid())) AND (a.organisation_id = invoices.organisation_id))))
);

ALTER POLICY "admins manage org jobs" ON public.jobs
USING (
  organisation_id IN (SELECT a.organisation_id FROM admins a WHERE a.user_id = (SELECT auth.uid()))
  OR (SELECT public.is_developer())
)
WITH CHECK (
  organisation_id IN (SELECT a.organisation_id FROM admins a WHERE a.user_id = (SELECT auth.uid()))
  OR (SELECT public.is_developer())
);

ALTER POLICY "members read org jobs" ON public.jobs USING (
  (organisation_id IN (SELECT a.organisation_id FROM admins a WHERE a.user_id = (SELECT auth.uid())) OR (SELECT public.is_developer()))
  OR (EXISTS ( SELECT 1 FROM users u WHERE ((u.auth_user_id = (SELECT auth.uid())) AND (u.organisation_id = jobs.organisation_id))))
  OR (EXISTS ( SELECT 1 FROM admins a WHERE ((a.user_id = (SELECT auth.uid())) AND (a.organisation_id = jobs.organisation_id))))
);

ALTER POLICY "admins manage leave_types" ON public.leave_types
USING (
  organisation_id IN (SELECT a.organisation_id FROM admins a WHERE a.user_id = (SELECT auth.uid()))
  OR (SELECT public.is_developer())
)
WITH CHECK (
  organisation_id IN (SELECT a.organisation_id FROM admins a WHERE a.user_id = (SELECT auth.uid()))
  OR (SELECT public.is_developer())
);

ALTER POLICY "members read leave_types" ON public.leave_types USING (
  (EXISTS ( SELECT 1 FROM users WHERE ((users.organisation_id = leave_types.organisation_id) AND (users.auth_user_id = (SELECT auth.uid())))))
  OR (organisation_id IN (SELECT a.organisation_id FROM admins a WHERE a.user_id = (SELECT auth.uid())) OR (SELECT public.is_developer()))
);

ALTER POLICY "members read own organisation" ON public.organisations USING (
  (id IN (SELECT a.organisation_id FROM admins a WHERE a.user_id = (SELECT auth.uid())) OR (SELECT public.is_developer()))
  OR (EXISTS ( SELECT 1 FROM users u WHERE ((u.auth_user_id = (SELECT auth.uid())) AND (u.organisation_id = organisations.id))))
);

ALTER POLICY "admins manage org projects" ON public.projects
USING (
  organisation_id IN (SELECT a.organisation_id FROM admins a WHERE a.user_id = (SELECT auth.uid()))
  OR (SELECT public.is_developer())
)
WITH CHECK (
  organisation_id IN (SELECT a.organisation_id FROM admins a WHERE a.user_id = (SELECT auth.uid()))
  OR (SELECT public.is_developer())
);

ALTER POLICY "members read org projects" ON public.projects USING (
  (organisation_id IN (SELECT a.organisation_id FROM admins a WHERE a.user_id = (SELECT auth.uid())) OR (SELECT public.is_developer()))
  OR (EXISTS ( SELECT 1 FROM users u WHERE ((u.auth_user_id = (SELECT auth.uid())) AND (u.organisation_id = projects.organisation_id))))
  OR (EXISTS ( SELECT 1 FROM admins a WHERE ((a.user_id = (SELECT auth.uid())) AND (a.organisation_id = projects.organisation_id))))
);

ALTER POLICY "admins manage holidays" ON public.public_holidays
USING (
  organisation_id IN (SELECT a.organisation_id FROM admins a WHERE a.user_id = (SELECT auth.uid()))
  OR (SELECT public.is_developer())
)
WITH CHECK (
  organisation_id IN (SELECT a.organisation_id FROM admins a WHERE a.user_id = (SELECT auth.uid()))
  OR (SELECT public.is_developer())
);

ALTER POLICY "members read holidays" ON public.public_holidays USING (
  (EXISTS ( SELECT 1 FROM users WHERE ((users.organisation_id = public_holidays.organisation_id) AND (users.auth_user_id = (SELECT auth.uid())))))
  OR (organisation_id IN (SELECT a.organisation_id FROM admins a WHERE a.user_id = (SELECT auth.uid())) OR (SELECT public.is_developer()))
);

ALTER POLICY "members read org quote lines" ON public.quote_lines USING (
  (organisation_id IN (SELECT a.organisation_id FROM admins a WHERE a.user_id = (SELECT auth.uid())) OR (SELECT public.is_developer()))
  OR (EXISTS ( SELECT 1 FROM users u WHERE ((u.auth_user_id = (SELECT auth.uid())) AND (u.organisation_id = quote_lines.organisation_id))))
);

ALTER POLICY "members read org quotes" ON public.quotes USING (
  (organisation_id IN (SELECT a.organisation_id FROM admins a WHERE a.user_id = (SELECT auth.uid())) OR (SELECT public.is_developer()))
  OR (EXISTS ( SELECT 1 FROM users u WHERE ((u.auth_user_id = (SELECT auth.uid())) AND (u.organisation_id = quotes.organisation_id))))
);

ALTER POLICY "admins manage org tasks" ON public.tasks
USING (
  organisation_id IN (SELECT a.organisation_id FROM admins a WHERE a.user_id = (SELECT auth.uid()))
  OR (SELECT public.is_developer())
)
WITH CHECK (
  organisation_id IN (SELECT a.organisation_id FROM admins a WHERE a.user_id = (SELECT auth.uid()))
  OR (SELECT public.is_developer())
);

ALTER POLICY "members read org tasks" ON public.tasks USING (
  (organisation_id IN (SELECT a.organisation_id FROM admins a WHERE a.user_id = (SELECT auth.uid())) OR (SELECT public.is_developer()))
  OR (EXISTS ( SELECT 1 FROM users u WHERE ((u.auth_user_id = (SELECT auth.uid())) AND (u.organisation_id = tasks.organisation_id))))
  OR (EXISTS ( SELECT 1 FROM admins a WHERE ((a.user_id = (SELECT auth.uid())) AND (a.organisation_id = tasks.organisation_id))))
);


-- ------------------------------------------------------------- the check --
do $chk$
declare bad text; ids text;
begin
  if not exists (select 1 from _who_187 where who = 'developer') then
    raise exception '187 NOT applied - the developer account named in the guard was not found. Everything rolled back.';
  end if;
  select string_agg(who, '+' order by who) into ids from _who_187;
  select string_agg(b.what, ', ' order by b.what) into bad
    from _before_187 b
    left join (select f.* from _who_187 w, lateral pg_temp.fp187(w.who, w.rol, w.sub, w.email) f) a using (what)
   where a.val is distinct from b.val;
  if bad is not null then
    raise exception '187 NOT applied - visible rows changed for: %. Everything rolled back.', bad;
  end if;
  raise notice '187 applied: all % fingerprints (10 tables x %) identical before and after', (select count(*) from _before_187), ids;
end $chk$;

commit;

notify pgrst, 'reload schema';

-- The SQL editor shows only the last result: 0 = no touched policy still calls is_admin_of().
select count(*) as policies_still_calling_is_admin_of_expect_0
  from pg_policies
 where schemaname = 'public'
   and tablename in ('jobs','quotes','quote_lines','invoices','departments','organisations','projects','tasks','leave_types','public_holidays')
   and (coalesce(qual, '') like '%is_admin_of(%' or coalesce(with_check, '') like '%is_admin_of(%');
