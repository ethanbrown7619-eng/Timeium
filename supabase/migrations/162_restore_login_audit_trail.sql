-- 162_restore_login_audit_trail.sql
-- Security audit 2026-08, findings A3 (Medium) and A5 (Medium).
--
-- A3 — public.login_attempts currently has NO WRITER AT ALL, so
-- check_login_locked() always returns false and there is no failed-login
-- forensic trail. How it happened, each step reasonable on its own:
--
--   139  correctly removed the forgeable `succeeded` flag from the anon RPC.
--   142  added a Password Verification Attempt auth hook as the
--        authoritative recorder — the right design.
--   ---  signin.js then stopped recording client-side, on the stated
--        grounds that the hook now did it ("we no longer record from here
--        (doing so would double-count and skew the lockout)").
--   ---  but the 142 hook is Team/Enterprise-only and could not be enabled
--        on the current Supabase plan, so it never started recording.
--
-- Net: the client stopped writing because the hook was going to, and the
-- hook was never switched on. The table has been empty ever since.
--
-- A5 — the obvious fix (just call the anon RPC again) would ship a DoS:
-- record_login_attempt is anon-callable and keyed purely on a
-- client-supplied email, so anyone who knows an employee's address could
-- post 5 failures and lock them out of the sign-in form for 15 minutes,
-- indefinitely. Migration 139's header flagged exactly this and deferred it.
--
--------------------------------------------------------------------------------
-- THE FIX: separate the AUDIT concern from the LOCKOUT concern
--------------------------------------------------------------------------------
-- The two things were conflated in one table with one meaning. Splitting
-- them by provenance solves both findings at once:
--
--   source = 'auth_hook'  written by the 142 hook inside the auth server.
--                         Unforgeable. THE ONLY SOURCE THE LOCKOUT COUNTS.
--   source = 'client'     failure reported by the sign-in page. Anon, so
--                         inherently untrusted — useful as forensics,
--                         never load-bearing.
--   source = 'session'    success confirmed by an authenticated caller;
--                         the email is derived from auth.uid(), so it
--                         cannot be fabricated for another account.
--
-- Consequences:
--   * The audit trail comes back TODAY, on the current plan, clearly
--     labelled by trust level.
--   * Flooding the anon endpoint can no longer trip the lockout for a
--     victim — A5 is closed by construction rather than deferred again.
--   * If the 142 hook is ever enabled, the lockout becomes binding with
--     no further code change.
--
-- Be clear about what this does NOT do: with the hook unavailable there is
-- still no account lockout. Brute-force resistance rests on Supabase's
-- per-IP auth rate limiting and on Turnstile CAPTCHA enforcement
-- (Authentication -> Attack Protection), which is the primary control and
-- is already plumbed client-side. Enable it.
--
-- Safe to re-run.

--------------------------------------------------------------------------------
-- 1. Provenance column
--------------------------------------------------------------------------------

-- Added with default 'legacy' so pre-existing rows (which came from the
-- pre-139 client or the hook and can't be told apart) are backfilled as
-- untrusted, THEN the default flips to 'client' for new writes. Doing it
-- in this order makes the backfill a property of the ADD COLUMN rather
-- than a separate UPDATE — so re-running this migration cannot reclassify
-- genuine 'client' rows as legacy.
alter table public.login_attempts
    add column if not exists source text not null default 'legacy';

alter table public.login_attempts
    alter column source set default 'client';

do $$
begin
    -- Scope the lookup to this table: conname is unique per table, not
    -- globally, so an unqualified check could match someone else's.
    if not exists (
        select 1 from pg_constraint
         where conname  = 'login_attempts_source_check'
           and conrelid = 'public.login_attempts'::regclass
    ) then
        alter table public.login_attempts
            add constraint login_attempts_source_check
            check (source in ('auth_hook', 'client', 'session', 'legacy'));
    end if;
end$$;

-- The lockout query filters on (email, succeeded, source, attempted_at).
create index if not exists login_attempts_lockout_idx
    on public.login_attempts (email, attempted_at desc)
    where succeeded = false and source = 'auth_hook';

--------------------------------------------------------------------------------
-- 2. record_login_attempt — anon failure reporting, flood-capped
--------------------------------------------------------------------------------
-- Still anon-callable (it has to be: the caller has no session when a
-- sign-in fails). It can no longer influence the lockout, but an attacker
-- could still try to inflate the table, so cap how many rows one email can
-- contribute per window. Over the cap the call succeeds and writes nothing
-- — the client must not be able to distinguish, and must never fail a
-- sign-in because logging failed.

create or replace function public.record_login_attempt(
    p_email          text,
    p_failure_reason text default null,
    p_user_agent     text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    v_email  text := lower(coalesce(p_email, ''));
    v_recent integer;
begin
    if v_email = '' then
        return;
    end if;

    select count(*) into v_recent
      from public.login_attempts
     where email        = v_email
       and source       = 'client'
       and attempted_at > now() - interval '15 minutes';

    -- 20 per email per 15 min is far above any legitimate rate and bounds
    -- what a flood can add.
    if v_recent >= 20 then
        return;
    end if;

    -- Truncated: these are attacker-controlled strings on an anon endpoint.
    -- nullif preserves the previous NULL-means-unspecified semantics.
    insert into public.login_attempts (email, succeeded, failure_reason, user_agent, source)
    values (v_email, false,
            nullif(left(coalesce(p_failure_reason, ''), 200), ''),
            nullif(left(coalesce(p_user_agent, ''), 400), ''),
            'client');
end$$;

revoke all on function public.record_login_attempt(text, text, text) from public;
grant execute on function public.record_login_attempt(text, text, text) to anon, authenticated;

--------------------------------------------------------------------------------
-- 3. record_login_success — authenticated, email derived server-side
--------------------------------------------------------------------------------

create or replace function public.record_login_success()
returns void
language plpgsql security definer set search_path = public
as $$
declare
    v_email text;
begin
    select email into v_email from auth.users where id = auth.uid();
    if v_email is null then
        return;
    end if;
    insert into public.login_attempts (email, succeeded, failure_reason, source)
    values (lower(v_email), true, null, 'session');
end$$;

revoke all on function public.record_login_success() from public;
grant execute on function public.record_login_success() to authenticated;

--------------------------------------------------------------------------------
-- 4. check_login_locked — counts ONLY authoritative hook failures
--------------------------------------------------------------------------------
-- This is the line that closes A5: anon-written rows are excluded, so
-- nobody can lock out a victim by posting failures.

create or replace function public.check_login_locked(p_email text)
returns boolean
language sql security definer set search_path = public stable
as $$
  select (
    select count(*)
      from public.login_attempts
     where email        = lower(coalesce(p_email, ''))
       and succeeded    = false
       and source       = 'auth_hook'
       and attempted_at > now() - interval '15 minutes'
  ) >= 5;
$$;

revoke all on function public.check_login_locked(text) from public;
grant execute on function public.check_login_locked(text) to anon, authenticated;

--------------------------------------------------------------------------------
-- 5. password_verification_hook — stamp its rows as authoritative
--------------------------------------------------------------------------------
-- Body is otherwise migration 142's. Still needs enabling at
-- Authentication -> Hooks to do anything.

create or replace function public.password_verification_hook(event jsonb)
returns jsonb
language plpgsql security definer set search_path = public, auth, extensions
as $$
declare
    v_uid        uuid;
    v_valid      boolean;
    v_email      text;
    v_fail_count integer;
begin
    v_uid   := nullif(event->>'user_id', '')::uuid;
    v_valid := coalesce((event->>'valid')::boolean, false);
    if v_uid is null then
        return jsonb_build_object('decision', 'continue');
    end if;

    select email into v_email from auth.users where id = v_uid;
    if v_email is null then
        return jsonb_build_object('decision', 'continue');
    end if;

    insert into public.login_attempts (email, succeeded, failure_reason, source)
    values (lower(v_email), v_valid,
            case when v_valid then null else 'password_verification' end,
            'auth_hook');

    select count(*) into v_fail_count
      from public.login_attempts
     where email        = lower(v_email)
       and succeeded    = false
       and source       = 'auth_hook'
       and attempted_at > now() - interval '15 minutes';

    if v_fail_count >= 5 then
        return jsonb_build_object(
            'decision', 'reject',
            'message',  'Too many failed sign-in attempts. Please wait 15 minutes and try again.'
        );
    end if;

    return jsonb_build_object('decision', 'continue');
end$$;

revoke execute on function public.password_verification_hook(jsonb) from authenticated, anon, public;
grant execute on function public.password_verification_hook(jsonb) to supabase_auth_admin;

--------------------------------------------------------------------------------
-- 6. Retention — the table is now written on every failed sign-in again
--------------------------------------------------------------------------------
-- 180 days is well past any forensic need here and keeps the table bounded.
-- Guarded so this migration still applies where pg_cron isn't installed.

create or replace function public.prune_login_attempts()
returns integer
language plpgsql security definer set search_path = public
as $$
declare v_count integer;
begin
    delete from public.login_attempts
     where attempted_at < now() - interval '180 days';
    get diagnostics v_count = row_count;
    return v_count;
end$$;

revoke all on function public.prune_login_attempts() from public, anon, authenticated;

do $$
begin
    if not exists (select 1 from pg_extension where extname = 'pg_cron') then
        raise warning 'pg_cron not installed — schedule public.prune_login_attempts() manually';
        return;
    end if;

    if exists (select 1 from cron.job where jobname = 'prune-login-attempts') then
        perform cron.unschedule('prune-login-attempts');
    end if;

    perform cron.schedule('prune-login-attempts', '17 3 * * *',
                          'select public.prune_login_attempts();');
end$$;

--------------------------------------------------------------------------------
-- VERIFICATION
--
-- 1. Fail a sign-in once at /signin.html, then as a DEVELOPER:
--
--      select email, succeeded, source, failure_reason, attempted_at
--        from public.login_attempts order by attempted_at desc limit 10;
--
--    Expect a row with source = 'client'. Sign in successfully and expect
--    a second row with source = 'session'.
--
-- 2. Confirm the anon endpoint cannot lock anyone out. Post 6+ failures
--    for an address you control, then:
--
--      select public.check_login_locked('victim@example.com');   -- false
--
--    and confirm that address can still sign in normally. Before this
--    migration that would have returned true and blocked the sign-in form.
--
-- 3. If the 142 hook is ever enabled: rows appear with source =
--    'auth_hook', and check_login_locked() starts returning true after 5
--    failures in 15 minutes — with no further code change.
--------------------------------------------------------------------------------
