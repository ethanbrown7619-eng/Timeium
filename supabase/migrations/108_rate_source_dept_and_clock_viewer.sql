-- 108_rate_source_dept_and_clock_viewer.sql
-- Two additions to public.users:
--
-- 1. rate_source_department_id (nullable FK) — when set, this user's
--    cost/sell rates are inherited from the named department instead of
--    being a manual override or falling through to their own department.
--    Use case: a manager organisationally sits in a "Management"
--    department for approval / org-chart purposes, but should bill at
--    Workshop's rates because that's where they actually work.
--
--    Rate-lookup precedence (existing JS in admin.js effectiveRate):
--      1. rate_source_department_id set -> that dept's rate
--      2. else users.cost_rate / sell_rate set -> those (manual override)
--      3. else users.department_id's dept rate (current default)
--
-- 2. can_view_clock_comparison (boolean) — grants the user access to the
--    Admin tab BUT only to the Timesheet vs Clock sub-page. Other admin
--    tabs (Dashboard, Infusion Export, Leave Report, Dev Tools) are
--    hidden in the UI. Database-side, the user gets SELECT on the same
--    tables admins read so the comparison page can populate.

alter table public.users
    add column if not exists rate_source_department_id bigint
        references public.departments (id) on delete set null,
    add column if not exists can_view_clock_comparison boolean not null default false;

create index if not exists users_rate_source_dept_idx
    on public.users (rate_source_department_id);

-- SECURITY DEFINER helper so RLS policies can check the flag without
-- recursive self-reference on public.users.
create or replace function public.user_can_view_clock_comparison(p_org_id bigint)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.users
    where auth_user_id          = auth.uid()
      and can_view_clock_comparison = true
      and organisation_id       = p_org_id
  );
$$;

grant execute on function public.user_can_view_clock_comparison(bigint) to authenticated;

-- Read-only access to the four tables the Timesheet vs Clock page reads.
-- Limited to SELECT — these users cannot write anywhere admins write.

do $$
begin
    if not exists (select 1 from pg_policies
                    where schemaname = 'public' and tablename = 'users'
                      and policyname = 'clock viewers read org users') then
        execute $policy$
            create policy "clock viewers read org users"
              on public.users for select
              to authenticated
              using (public.user_can_view_clock_comparison(organisation_id))
        $policy$;
    end if;
end$$;

do $$
begin
    if not exists (select 1 from pg_policies
                    where schemaname = 'public' and tablename = 'departments'
                      and policyname = 'clock viewers read org departments') then
        execute $policy$
            create policy "clock viewers read org departments"
              on public.departments for select
              to authenticated
              using (public.user_can_view_clock_comparison(organisation_id))
        $policy$;
    end if;
end$$;

do $$
begin
    if not exists (select 1 from pg_policies
                    where schemaname = 'public' and tablename = 'timesheets'
                      and policyname = 'clock viewers read org timesheets') then
        execute $policy$
            create policy "clock viewers read org timesheets"
              on public.timesheets for select
              to authenticated
              using (public.user_can_view_clock_comparison(organisation_id))
        $policy$;
    end if;
end$$;

do $$
begin
    if not exists (select 1 from pg_policies
                    where schemaname = 'public' and tablename = 'timesheet_entries'
                      and policyname = 'clock viewers read org entries') then
        execute $policy$
            create policy "clock viewers read org entries"
              on public.timesheet_entries for select
              to authenticated
              using (
                exists (
                  select 1 from public.timesheets ts
                  where ts.id = timesheet_entries.timesheet_id
                    and public.user_can_view_clock_comparison(ts.organisation_id)
                )
              )
        $policy$;
    end if;
end$$;
