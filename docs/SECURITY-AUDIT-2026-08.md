# PTL Timesheet — Security Audit, August 2026

Independent code audit of the PTL Timesheet app, its Cloudflare Worker, the
Supabase database surface it shares with PTL Clock, and the notification
edge function. Read alongside [SECURITY-TESTING.md](SECURITY-TESTING.md),
which describes the standing posture; this document records what a fresh
pass found on top of it.

**Method:** static review of all 90 migrations plus `schema-replica.sql`
(RLS policies, `SECURITY DEFINER` bodies, and EXECUTE grants including the
PTL Clock repo's grants on shared functions), a sweep of all 432
template-literal interpolations into HTML sinks across the 12 front-end
modules, review of `worker.js` and the two edge functions, and **live
header probes against the deployed origin**.

**Headline:** the database authorization work (migrations 054, 139–143) is
genuinely good and holds up under review. The two most serious findings are
elsewhere — a whole class of HTTP security controls that is documented as
enforced but is **not actually being sent in production**, and two shared
clock RPCs that are reachable by any signed-in employee for any
organisation.

---

## Severity summary

| ID | Sev | Finding | Verified how |
|----|-----|---------|--------------|
| [A1](#a1) | **High** | All HTTP security headers (CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy) are absent in production, and the geo-block is inert for the whole app | Live probe |
| [A2](#a2) | **High** | `org_live_status` and `_offsite_report` are `SECURITY DEFINER`, granted to `authenticated`, take a caller-supplied `p_org_id`, and perform **no authorisation check** | Code + grants |
| [A3](#a3) | **Medium** | The login audit log and account lockout are completely inert — nothing writes `login_attempts` anymore | Code |
| [A4](#a4) | **Medium** | Any department lead reads every user row in the org (including `cost_rate` / `sell_rate`) and every timesheet in the org | Policy definitions |
| [A5](#a5) | **Medium** | Anonymous lockout-poisoning DoS — latent today, becomes live the moment A3 is fixed the obvious way | Code |
| [A6](#a6) | Low | `organisations` SELECT is still `using (true)` — cross-tenant read of org settings | Policy definition |
| [A7](#a7) | Low | CSP allows `https://esm.sh` in `script-src`, which is close to `script-src *` | Code |
| [A8](#a8) | Low | `must_change_password` is enforced client-side only | Code (known) |
| [A9](#a9) | Low | `provision_employee_login` links an existing auth account by email match without proving ownership | Code |

## Remediation status

| ID | Change | Where | Still needs |
|----|--------|-------|-------------|
| A1 | Headers moved to the asset layer | `public/_headers`, `worker.js` | `npx wrangler deploy`, then `curl -I` to verify |
| A2 | Gated wrappers over renamed `*_impl` | migration `159` | Apply in SQL editor; coordinate with PTL Clock repo |
| A3 | Audit trail restored, tagged by provenance | migration `162`, `signin.js` | Apply; **enable Turnstile enforcement** |
| A4 | Read policies re-keyed on `user_manages_target_user` | migration `160` | Apply; retest manager dashboard |
| A5 | Lockout counts only `auth_hook` rows | migration `162` | Apply |
| A6 | `organisations` scoped to members/admins | migration `161` | Apply; retest developer org switcher |
| A7 | — | — | Open, optional (vendor `xlsx`/`jspdf`) |
| A8 | Enforced in `getUserContext()` | `shared.js` + 3 callers | Deploy |
| A9 | Link guard + unique index | migration `163` | Apply |

Migrations are idempotent and each carries its own verification block.
Apply them in order, 159 → 163.

---

## A1 — Security headers and geo-blocking are inert in production {#a1}

**Severity: High.** Verified live, 2026-08-04.

`worker.js` builds a thorough `addSecurityHeaders()` — CSP, HSTS,
`X-Frame-Options: DENY`, `nosniff`, Referrer-Policy, Permissions-Policy —
and both `README.md` and `SECURITY-TESTING.md` state these are enforced.
They are not, on any page a user actually loads.

The cause is in `wrangler.toml`: `run_worker_first` is intentionally off
(it was turned off after it caused an outage). With it off, Cloudflare's
asset layer serves anything matching a file in `public/` **directly,
without invoking the Worker at all**. `addSecurityHeaders()` only runs on
the `env.ASSETS.fetch()` fallthrough — which is reached only for paths that
match *no* asset (the SPA fallback).

Probing the deployed origin:

```
$ curl -I https://temporium.ethanbrown7619.workers.dev/signin.html
cache-control: public, max-age=0, must-revalidate
content-type: text/html
        ← no CSP, no HSTS, no X-Frame-Options, no nosniff, nothing

$ curl -I https://temporium.ethanbrown7619.workers.dev/js/shared.js
cache-control: no-cache
        ← same

$ curl -I https://temporium.ethanbrown7619.workers.dev/definitely-not-an-asset
content-security-policy: default-src 'self'; script-src 'self' https://esm.sh …
strict-transport-security: max-age=31536000; includeSubDomains
x-frame-options: DENY
        ← the headers exist ONLY on the SPA-fallback path
```

Consequences, in order of practical impact:

1. **The app is framable.** No `X-Frame-Options` and no `frame-ancestors`
   on any real page means `/timesheet.html`, `/department.html` and
   `/admin.html` can be embedded in an attacker's page and clickjacked —
   and this app's UI is full of one-click state changes (approve
   timesheet, approve/revoke leave, delete employee).
2. **No CSP.** The `escapeHtml` discipline is currently the *only* XSS
   defence, not the second layer the docs describe.
3. **No HSTS** on the pages that matter.
4. **No `nosniff`**.
5. **The geo-block is inert.** `BLOCKED_COUNTRIES` in `worker.js` only
   filters requests that reach the Worker, i.e. `/xero/*` and unmatched
   paths. A browser in RU/CN/NG loads the entire app normally. Note that
   the block would never have been a real control anyway (it is trivially
   bypassed with a VPN), but it is currently not even doing the thing it
   was asked to do.

`/config.json` is also being served from the static `public/config.json`
rather than from the Worker — visible in the response having an `ETag` and
`max-age=0` instead of the Worker's `max-age=300`. Harmless (identical
content, and both values are public), but worth knowing: the Worker is not
in the request path for it.

**Recommended fix — low risk, no outage exposure.** Cloudflare Workers
Assets honours a `public/_headers` file, which is already present and used
for `Cache-Control`. Move the security headers there so they are applied by
the asset layer itself. Leave `addSecurityHeaders()` in `worker.js` as-is
so the fallback path stays covered, and leave `run_worker_first` off.

```
# public/_headers
/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Content-Security-Policy: default-src 'self'; script-src 'self' https://esm.sh https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://*.supabase.co https://esm.sh; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
```

Verify after deploy with the same `curl -I` on `/signin.html`. Ship CSP in
`Content-Security-Policy-Report-Only` first for a day if you want to be
careful — the inline `style="…"` attributes are already covered by
`style-src 'unsafe-inline'`, so it should pass clean, but the app has never
actually run under this policy.

---

## A2 — Two shared clock RPCs have no authorisation check {#a2}

**Severity: High.** Verified from source and grants; not exercised against
the live database (that needs a real employee session — see
[verification](#verifying-a2)).

`public.org_live_status(p_org_id)` and
`public._offsite_report(p_org_id, p_start, p_end_excl, p_tz)` are both
`SECURITY DEFINER` (so they bypass RLS), both take the organisation id
**straight from the caller**, and neither performs any authorisation check
at all — no `is_admin_of`, no `resolve_org_id`, nothing
(`supabase/migrations/149_clock_reports_use_department_id.sql:21` and
`:157`).

Both are explicitly granted to `authenticated` by the PTL Clock repo:

```
PTL-clock-in-out/supabase/migrations/028_query_perf.sql:272
    grant execute on function public.org_live_status(bigint) to authenticated;
PTL-clock-in-out/supabase/migrations/208_offsite_personal.sql:548
    grant execute on function public._offsite_report(bigint, date, date, text) to authenticated;
```

So **any** authenticated user — a regular employee with no admin row, no
`is_manager` flag, and `can_view_clock_comparison = false` — can POST to
`/rest/v1/rpc/org_live_status` or `/rest/v1/rpc/_offsite_report` with any
`p_org_id` and receive:

- every employee's name, department, live on-site/off-site status, current
  break and how long they've been on it (`org_live_status`);
- every employee's off-site spells, break overruns, late-backs, and
  clock-out-early events over an arbitrary date range (`_offsite_report`).

Because `p_org_id` is unchecked, this is not only a privilege escalation
inside one org — it is a **cross-tenant read**: an employee of org 1 can
enumerate org 2, 3, … in the shared Supabase project.

Two things make this worth taking seriously rather than filing as
theoretical:

- It directly contradicts §4 of `SECURITY-TESTING.md` ("every `SECURITY
  DEFINER` RPC re-checks the caller … Client checks exist only for UX").
- The front-end already knows. `public/js/timeclock.js:363` carries the
  comment: *"org_live_status … doesn't gate server-side — anyone with a
  valid session can call it (our clock-viewer / admin UI permission is
  app-side via the topbar nav)."* That is exactly the "UI is not a security
  control" failure mode the threat model warns about, written down and then
  shipped.

This also means `SECURITY-TESTING.md` §6 understates the clock-viewer
limitation. It says department scoping is "a display scope, not an RLS
boundary" — true, but the actual position is that the *page-level*
permission is a display scope too, and the org boundary along with it.

Note the contrast with the sibling function `weekly_timesheet`
(`schema-replica.sql:1504`), which does this correctly: it resolves the
admin row, falls back to `can_view_clock_comparison`, raises `not
authorised` otherwise, and explicitly rejects an org override
(`if p_org_id is not null and p_org_id <> v_clock_viewer_org then raise
exception 'org override not permitted'`). Its private helper
`_timesheet_rows` is correspondingly `revoke all … from public`. The same
pattern simply was not applied to these two.

**Recommended fix.** Give both functions the `weekly_timesheet` gate. For
`_offsite_report`, the cleaner shape is to revoke it from `public` and add
a thin `offsite_report(p_start, p_end_excl, p_tz, p_org_id default null)`
wrapper that does the check, matching how `_timesheet_rows` is already
handled — then point `timeclock.js` at the wrapper.

**Cross-repo coordination required.** These functions are owned by PTL
Clock, and `SECURITY-TESTING.md` §5 rule 5 applies: snapshot the live
definition with `pg_get_functiondef` before editing, and make the change in
the Clock repo (or in a Timesheet migration that the Clock side is told
about) so the next Clock migration does not clobber it. Migration 149 in
*this* repo already recreates all three functions, which is precisely the
shared-ownership hazard the developer guide warns about.

### Verifying A2 {#verifying-a2}

From a browser console signed in as an ordinary employee:

```js
// Expect: rows. Correct behaviour after the fix: an error.
await sb.rpc("org_live_status", { p_org_id: 1 });

// Try an org the user is not a member of.
await sb.rpc("org_live_status", { p_org_id: 2 });
```

Confirm the grants as they actually stand in the live database:

```sql
select p.proname,
       pg_get_userbyid(p.proowner) as owner,
       p.prosecdef,
       array(select unnest(p.proacl)::text) as acl
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('org_live_status', '_offsite_report', '_timesheet_rows');
```

---

## A3 — The login audit log and lockout are inert {#a3}

**Severity: Medium.**

`public.login_attempts` currently has **no writer**, so
`check_login_locked()` always returns false and there is no failed-login
forensic trail at all.

How it got here — each step was individually reasonable:

1. Migration 139 correctly removed the forgeable `succeeded` flag from the
   anon RPC (finding M3), leaving `record_login_attempt(email, reason,
   user_agent)` recording failures only.
2. Migration 142 added a Supabase *Password Verification Attempt* auth hook
   as the authoritative recorder, which is the right design.
3. `signin.js` was then updated to stop recording client-side, with the
   comment at `public/js/signin.js:49`: *"Attempts are recorded
   authoritatively by the Password Verification auth hook (migration 142) …
   We no longer record from here (doing so would double-count and skew the
   lockout)."*
4. But per `SECURITY-TESTING.md` §6, **the 142 hook cannot be enabled on
   the current Supabase plan** — it is a Team/Enterprise feature.

So the client stopped writing on the assumption the hook would write, and
the hook was never switched on. `grep` confirms no remaining caller of
`record_login_attempt` anywhere in `public/`. The pre-check at
`signin.js:36` still runs, still calls `check_login_locked`, and now always
gets `false`.

The practical exposure is bounded — Supabase's per-IP auth rate limiting
and bcrypt cost still stand between an attacker and password guessing, as
§6 says. But the *stated* posture is "the lockout remains advisory
(client-side check only)", and the real posture is "there is no lockout and
no failed-login audit trail". The audit trail is the part that matters
most: it is what several of the earlier graded findings assumed would exist
for forensic review, and it is what a developer looking at
`/rest/v1/login_attempts` would wrongly conclude is populated.

**Recommended fix**, in order of preference:

1. **Enable Turnstile enforcement in Supabase → Authentication → Attack
   Protection.** This is already fully plumbed (`public/js/turnstile.js`,
   the site key is in `wrangler.toml`, and `signInWithPassword` already
   passes `captchaToken`) — it is a dashboard toggle away. It applies to
   direct `/auth/v1/token` calls too, which is the bypass the lockout was
   meant to close, and it does not depend on the paid hook. This is the
   highest-value single action in this report after A1.
2. **Restore client-side failure recording** so the audit log lives again —
   a one-line `sb.rpc("record_login_attempt", …)` in the `if (error)` branch
   of `signin.js`. This brings back the advisory lockout and the forensic
   trail. Read [A5](#a5) first: this is what makes A5 live.
3. Keep migration 142 in place, and enable the hook if the plan is ever
   upgraded. Update `signin.js`'s comment either way — right now it
   documents a design that is not in effect.

---

## A4 — Department leads read the whole organisation {#a4}

**Severity: Medium.**

There are two "manager" concepts (documented in migration 053): an
`admins.role = 'manager'` org-level role, and the `users.is_manager = true`
department-lead flag set from `staff.html`. The *write* paths correctly use
`user_manages_target_user(p_user_id)`, which joins through
`departments.manager_id` and is properly narrow. The *read* paths do not.

**Every user row in the org, including pay rates.** The `dept managers read
org users` policy (migration 053) uses `user_is_dept_manager_in_org()`,
which is only `is_manager = true and organisation_id = p_org_id` — no
department scoping:

```sql
create policy "dept managers read org users"
  on public.users for select
  using (public.user_is_dept_manager_in_org(organisation_id));
```

`public.users` carries `cost_rate` and `sell_rate` (migration 022 notes
them as pre-existing; `staff.js` renders them via `effectiveRate()`). So
any employee with the department-lead flag can `select * from users` and
read **every colleague's cost and sell rate**, email, employee code, and
employment type — including their own manager's, and including people in
departments they have nothing to do with.

**Every timesheet in the org.** The `managers read dept timesheets` and
`managers read dept entries` policies are named for department scope but
are written org-wide:

```sql
create policy "managers read dept timesheets"
  on public.timesheets for select to authenticated
  using (exists (select 1 from public.users mgr
                  where mgr.auth_user_id = auth.uid()
                    and mgr.is_manager = true
                    and mgr.organisation_id = timesheets.organisation_id));
```

Same shape for `timesheet_entries`. So a department lead reads every
employee's weekly hours, job codes, task codes and entry notes across the
whole organisation.

This is a confidentiality issue rather than an integrity one — the
matching `FOR ALL` write policies from migration 118 are correctly gated on
`user_manages_target_user`, so a lead still cannot *edit* outside their
departments. Whether org-wide read is acceptable is partly a business call
(these are trusted internal staff), but pay rates in particular are the
kind of data where "the manager dashboard needed to see the team" is not a
sufficient reason to expose the whole roster.

**Recommended fix.** Replace `user_is_dept_manager_in_org(organisation_id)`
in the read policies with a department-scoped predicate — the
`user_manages_target_user(id)` helper already exists and is exactly right
for `users`:

```sql
drop policy if exists "dept managers read org users" on public.users;
create policy "dept managers read own reports"
  on public.users for select to authenticated
  using (public.user_manages_target_user(id));
```

and the equivalent on `timesheets` / `timesheet_entries` via
`user_manages_target_user(timesheets.user_id)`. Check
`department.js` and `staff.js` afterwards — the manager dashboard's
org-chart view may legitimately need names org-wide, in which case expose
that through a name-and-department-only view rather than widening the
policy back out over the rate columns.

---

## A5 — Anonymous lockout-poisoning DoS (latent) {#a5}

**Severity: Medium if [A3](#a3) is fixed by restoring client-side
recording; effectively inert today.**

`record_login_attempt(text, text, text)` is granted to `anon` and keys
purely on a client-supplied email. Anyone who knows an employee's email
address — e.g. anyone who has ever received mail from
`clockapp@ptlmachinery.com`, or who can guess `firstname@ptlmachinery.com`
— can POST five failure rows and lock that account out of the sign-in form
for 15 minutes, repeating indefinitely, without ever authenticating.

Migration 139's header already anticipates this: *"Keying the lockout on
(email, IP) to fully neutralise the fake-failure DoS needs request-IP
plumbing at the edge and is deferred until the binding server-side lockout
(auth hook) lands."*

Today it is harmless only because A3 means nothing consults the result. It
is called out separately so that fixing A3 does not silently ship this.

**Recommended fix.** If you restore client-side recording, either require a
Turnstile token on `record_login_attempt` (verified server-side), or key
the lockout on `(email, ip)` — the Worker can forward `CF-Connecting-IP`,
though that means routing the sign-in RPC through the Worker. The simplest
adequate answer for this app's exposure: enable Turnstile enforcement
(A3 fix #1) and treat the email-keyed count as forensics only, not as a
gate.

---

## A6 — `organisations` is readable cross-tenant {#a6}

**Severity: Low.**

`create policy "read organisations" on public.organisations for select to
authenticated using (true)` (`schema-replica.sql:1536`) is still in place.
This was the vehicle for finding C1, and migration 141 did the important
half of the fix — it moved SMTP passwords and webhook keys into
`org_secrets` (admin-scoped RLS) and NULLed the old columns. That part is
solid, and the C1 exposure is genuinely closed.

What was never done is narrowing the policy itself. Any authenticated user
in any org can still read every organisation row: names, approval
workflow, deadline and reminder schedules, `notify_overdue_recipient`,
the jobs/tasks/dept-codes import maps, and employment-type settings. No
secrets, but it is an open multi-tenant boundary and it will silently
re-expose anything a future migration adds to that table — which is exactly
how C1 happened.

**Recommended fix.**

```sql
drop policy if exists "read organisations" on public.organisations;
create policy "members read own organisation"
  on public.organisations for select to authenticated
  using (public.is_admin_of(id)
         or exists (select 1 from public.users u
                     where u.auth_user_id = auth.uid()
                       and u.organisation_id = organisations.id));
```

Check the developer org-switcher before shipping — `is_admin_of` already
returns true for developers on any org, so it should be unaffected, but
that is the one flow that depends on reading other orgs.

---

## A7 — CSP allows `https://esm.sh` in `script-src` {#a7}

**Severity: Low** (and currently moot — see [A1](#a1); the CSP is not being
sent at all).

`esm.sh` is a general-purpose CDN that will serve any npm package. Once the
CSP is actually deployed, `script-src 'self' https://esm.sh` means an
attacker with an HTML-injection foothold can load
`https://esm.sh/<anything>` and execute it. That is much weaker than the
"meaningful XSS containment" the `worker.js` comment claims for dropping
`'unsafe-inline'`.

`SECURITY-TESTING.md` §6 already flags the supply-chain half of this
("vendoring them too would remove the remaining third-party runtime
dependency"). The XSS-containment half is the better argument for doing it:
vendoring `xlsx` and `jspdf` the way `supabase-js` is already vendored lets
you drop `esm.sh` from both `script-src` and `connect-src` and makes the
CSP actually restrictive.

Sequence this **after** A1 — deploy the CSP as-is first, then tighten.

---

## A8 — `must_change_password` is enforced client-side only {#a8}

**Severity: Low.** Already documented in migration 140's header as a
recommended follow-up; recorded here for completeness.

`signin.js:70` redirects to `/change-password.html` when the flag is set,
but nothing stops a user from navigating elsewhere instead. Since migration
140 replaced the shared literal `PASSWORD` with a random per-user
credential delivered out of band, there is no longer an attacker-known
password to exploit — the residual risk is a user declining to set their
own password and continuing on the admin-issued one. Fix if you want the
belt-and-braces: gate the app's RLS reads on `must_change_password = false`,
or check the flag in `routeAfterAuth()` in `shared.js` rather than only on
the sign-in path.

---

## A9 — `provision_employee_login` links accounts by email match {#a9}

**Severity: Low.**

`provision_employee_login` (migration 140) checks
`is_admin_of(v_target_org)` on the *employee row's* org, then looks up
`auth.users` by email and, if a match exists, links it:

```sql
select id into v_uid from auth.users where lower(email) = lower(v_email);
...
update public.users set auth_user_id = v_uid, must_change_password = true where id = p_user_id;
```

An admin of org A can create an employee row bearing a known email address
belonging to a user of org B and call this, binding org B's auth identity
to an org A employee row. The effect is that org B's user gains an
additional identity in org A — org A learns nothing about org B, so this is
an admin granting away access rather than stealing it, and it requires
admin rights to begin with. Worth a guard nonetheless, since
`users.auth_user_id` is the key half the RLS policies join on and a user
matching two rows across orgs is not a state the policies were designed
for.

**Recommended fix.** Refuse to link when the matched `auth.users` row is
already referenced by a `public.users` row in a different organisation.

---

## What holds up

Not filler — these were checked and found sound, and they are the reason
the report has no critical findings.

**The 054 status-lock policies are correct.** Migration 054 dropped the
original `FOR ALL` catch-all policies (`users manage own timesheets`,
`users manage own entries`, `employees own leave_requests`) and replaced
them with per-command policies carrying explicit status guards. This
matters more than it looks: because Postgres OR-combines permissive
policies, leaving any of those `FOR ALL` policies in place would have let
an employee edit an approved timesheet or **self-approve their own leave
request** by direct PostgREST call. They were correctly and completely
removed — I traced every `create`/`drop` of each policy name across all
migrations and the replica snapshot to confirm.

**The graded findings C1/H1/M3/L5 are genuinely remediated**, not just
papered over. Secrets are in an admin-scoped table with the old columns
NULLed (141); temp passwords are random per-user with no shared credential
(140); the forgeable `succeeded` flag is gone and the success path derives
the email from `auth.uid()` (139); OAuth state nonces are burned on first
use against a service-role-only table (143). The pattern of documenting the
finding verbatim in the migration header is genuinely good practice and
made this audit much faster.

**XSS discipline holds.** `escapeHtml()` (`shared.js:569`) escapes all five
of `& < > " '`, which is correct for both text and quoted-attribute
contexts. I swept all 432 template-literal interpolations reaching an HTML
sink across the 12 front-end modules; every one carrying user- or
DB-controlled string data goes through `escapeHtml`. The unescaped
remainder are computed numbers, CSS class names, and literal constants. No
`eval`, no `new Function`, no `document.write`. Note this is currently the
*only* XSS defence — see [A1](#a1).

**The notification edge function's caller auth is sound.** It accepts the
service-role key or a self-managed `CRON_AUTH_TOKEN` for cron, otherwise
verifies the session with `auth.getUser()` and requires developer or an
admin row matching the requested org. The header comment records that this
function was previously an open SMTP relay via `test_send_to` — that is
closed.

**Xero handling is careful.** Tokens never reach the browser, the state
token is HMAC-signed with a constant-time comparison and a checked
expiry, the nonce is single-use, refresh tokens are persisted before use
(correct for Xero's rotating refresh tokens), and the service-role key is
confined to the Worker against a table whose RLS is `using (false)` for
`authenticated`.

**No secrets in the repo.** `wrangler.toml` carries only the Supabase URL,
the anon key, and the Turnstile *site* key — all public by design, all
correctly annotated as such. `.gitignore` covers `.dev.vars` and `.env`.
Service-role key, Xero client secret, and SMTP credentials are all
Cloudflare/Supabase secrets.

---

## Suggested order of work

1. **A1** — move the security headers into `public/_headers`. Highest
   impact, lowest risk, no database involvement, verifiable in one `curl`.
2. **A3 fix #1** — enable Turnstile enforcement in Supabase Attack
   Protection. A dashboard toggle; the code is already there. This is the
   real brute-force control and it does not need a plan upgrade.
3. **A2** — gate `org_live_status` and `_offsite_report`. Needs
   coordination with the PTL Clock repo; snapshot the live definitions
   first.
4. **A4** and **A6** — narrow the read policies. Straightforward
   migrations, but test the manager dashboard and the developer org
   switcher afterwards.
5. **A3 fix #2 / A5** together — restore the audit trail without shipping
   the DoS.
6. **A7**, **A8**, **A9** — hardening, no urgency.

## Corrections needed to existing documentation

Whichever findings you choose to fix, these statements are currently wrong
and should be corrected either way:

- `README.md`: "The worker also enforces a Content-Security-Policy and the
  usual hardening headers (HSTS, X-Frame-Options, …)" — it does not, for
  any real page (A1).
- `SECURITY-TESTING.md` §4: "every `SECURITY DEFINER` RPC re-checks the
  caller … Client checks exist only for UX" — two do not (A2).
- `SECURITY-TESTING.md` §6: "No Content-Security-Policy header yet" — a CSP
  exists in `worker.js` but is not served (A1); this line predates the CSP
  and is now wrong in a different direction than it looks.
- `SECURITY-TESTING.md` §6: "the account lockout remains advisory
  (client-side check only)" — there is currently no lockout at all and no
  failed-login audit trail (A3).
- `public/js/signin.js:49`: the comment describes recording via the 142
  hook, which is not enabled (A3).
