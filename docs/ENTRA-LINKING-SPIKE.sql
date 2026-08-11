-- =====================================================================
-- Entra sign-in — the go/no-go linking spike
-- =====================================================================
-- Run in the Supabase SQL editor on the REAL project, AFTER signing in
-- with Microsoft on the pilot host (temporium). Read-only: nothing here
-- writes. This cannot be run on the pg17 snapshot — its auth schema is a
-- fabricated shim with no auth.identities table.
--
-- THE QUESTION: when you sign in with Microsoft for the first time, does
-- Supabase attach that Entra identity to your EXISTING auth.users row, or
-- mint a brand new UUID? Everything in the ERP hangs off
-- public.users.auth_user_id. A new UUID means every RLS policy stops
-- recognising you.
--
-- Replace the email in BOTH queries with the account you tested with.
-- Verified 2026-08-11: ethan.brown@ptlmachinery.com is the right guinea
-- pig — its ERP email matches the Microsoft one, which is the whole basis
-- on which Supabase links. Testing with an account whose ERP email differs
-- from its Microsoft email is guaranteed to mint a new UUID and would read
-- as a false red light.
--
-- RUN QUERY 2 ONCE *BEFORE* THE MICROSOFT SIGN-IN, and keep the output.
-- These auth rows were made by our own provision_employee_login shim and
-- may not carry an 'email' identity row at all. Without the before-shot,
-- 'azure, email' vs 'azure' afterwards is ambiguous.
-- =====================================================================


-- ---------------------------------------------------------------------
-- Query 1 — the verdict
-- ---------------------------------------------------------------------
select
    u.name,
    u.email                                     as erp_email,
    u.auth_user_id,
    au.id                                       as auth_row_found,
    au.email_confirmed_at is not null           as email_confirmed,
    au.last_sign_in_at,
    (select string_agg(i.provider, ', ' order by i.provider)
       from auth.identities i
      where i.user_id = au.id)                  as providers_linked,
    (select count(*)
       from auth.users x
      where lower(x.email) = lower(u.email))    as auth_rows_with_this_email
  from public.users u
  left join auth.users au on au.id = u.auth_user_id
 where lower(u.email) = lower('REPLACE@ptlmachinery.com');

-- HOW TO READ IT
--
--   providers_linked now contains 'azure'  and  auth_rows_with_this_email = 1
--     -> LINKED. Green light. Rollout is mechanical: no data migration,
--        no change to users, RLS or module access. Proceed to Phase 3.
--        (Compare against the before-shot: what matters is that 'azure'
--        appeared on the SAME row the ERP already pointed at.)
--
--   providers_linked unchanged          and  auth_rows_with_this_email = 2
--     -> DUPLICATE MINTED. Red light. Supabase made a second auth.users
--        row and your ERP row still points at the old one. Do NOT roll
--        out. See "if it duplicated" below.
--
--   auth_row_found is null
--     -> auth_user_id points at a row that doesn't exist. Unrelated to
--        Entra, but worth knowing about.
--
-- Note: a duplicate is HARMLESS to the tested account and self-recovers.
-- Signing back in with the password lands on the original row as before.
-- claim_employee_by_email will NOT auto-repair it: that function only
-- claims rows where auth_user_id IS NULL, and this one is already set.


-- ---------------------------------------------------------------------
-- Query 2 — show every auth row for that email
-- ---------------------------------------------------------------------
-- Run this whichever way query 1 goes. If it duplicated, this is what
-- shows you both rows and which one the ERP is actually pointing at.
select
    au.id,
    au.email,
    au.created_at,
    au.last_sign_in_at,
    au.email_confirmed_at is not null       as email_confirmed,
    (select string_agg(i.provider, ', ' order by i.provider)
       from auth.identities i
      where i.user_id = au.id)              as providers,
    exists (select 1 from public.users u
             where u.auth_user_id = au.id)  as is_the_row_the_erp_uses
  from auth.users au
 where lower(au.email) = lower('REPLACE@ptlmachinery.com')
 order by au.created_at;


-- ---------------------------------------------------------------------
-- IF IT DUPLICATED — do not improvise a fix
-- ---------------------------------------------------------------------
-- Two routes, neither of which should be run without thinking it through:
--
--   a) Re-point public.users.auth_user_id at the new (azure) row. Fast,
--      but it orphans the password identity and has to be repeated for
--      all 44 staff accounts at rollout.
--
--   b) linkIdentity() from an already-signed-in session: the person signs
--      in with their password first, then links Microsoft to the session
--      they already have. Correct, keeps one row, but needs a UI flow
--      building — roughly a week.
--
-- Delete the stray auth row only after deciding, and only for the test
-- account.


-- ---------------------------------------------------------------------
-- Also worth confirming while you're here
-- ---------------------------------------------------------------------
-- How many accounts are shim-created but NOT email-confirmed? Those are
-- the ones most likely to duplicate at rollout even if your test linked.
select
    count(*) filter (where au.email_confirmed_at is not null) as confirmed,
    count(*) filter (where au.email_confirmed_at is null)     as not_confirmed,
    count(*)                                                  as total_with_login
  from public.users u
  join auth.users au on au.id = u.auth_user_id
 where u.active;
