# PTL Timesheet — Security Audit, part 2 (2026-08-06)

Follow-up to [SECURITY-AUDIT-2026-08.md](SECURITY-AUDIT-2026-08.md). Scope: the
surface added/changed since that pass — the cross-module **SSO mint** endpoint
and token flow, the **module-access** system (migrations 164/165), the
switcher/auth client code — plus a regression sweep of the prior remediations.
Method: four independent code reviewers (worker, DB layer, client, prior-fix
verification) cross-checked against a manual read of the SSO flow.

**Headline:** the module-access DB authorization is sound (no cross-org or
privilege-escalation hole) and every prior fix is intact. The real findings are
in the SSO feature: it worked but was under-hardened, and its CSP was
misconfigured so it silently failed on the production mirror.

## What was fixed in this pass (all in the Timeium repo)

| # | Finding | Sev | Fix |
|---|---------|-----|-----|
| B2 | CSP `connect-src` omitted the SSO broker origin, so the mint `fetch` was **browser-blocked on the production mirror** — SSO silently fell back to a login page | High (functional) | Added `https://temporium.ethanbrown7619.workers.dev` to `connect-src` in `public/_headers` **and** `worker.js` |
| S1 | The minted one-time login token was appended to whatever `href` the DB registry held, with no destination/scheme check — a developer or bad migration could repoint a tile at a hostile host and harvest every user's token (fleet account takeover); a `javascript:` href would execute | High (needs registry write) | `ssoDestOk()` in `shared.js`: registry rows are validated to `https` + the workers.dev fleet at **render**, at the **hop**, and unsafe rows are dropped from the menu |
| F1/F2 | `my_allowed_modules` / `module_access_granted` ignored `departments.active` and `users.active` — a deactivated dept's grants stayed live (invisible/unrevocable) and a deactivated employee kept access until token expiry (**offboarding gap**) | Low → but real | Migration **166** adds `coalesce(u.active,true)` + `coalesce(d.active,true)` to both readers |
| F4 | `module_access_granted`'s "never raises / safe in RLS" was by construction only | Info | Migration 166 wraps the body in a fail-closed `exception when others` |
| S1-db | DB-layer belt for the destination-binding fix: nothing stopped a hostile/typo'd `erp_modules.href` from being **stored** | Medium | Migration **167** adds a CHECK constraint restricting `href` to `https` + the workers.dev fleet |
| M1 | Worker-generated responses (mint, `/config.json`, `/xero` 410, error pages) shipped with no security headers; the 503 page was framable | Medium | `worker.js` now routes every response through `addSecurityHeaders` at a single decorated exit |
| M4 | GoTrue error bodies were logged at 100% sampling — could retain email/token in Workers Logs | Low | Log status code only |
| Q1 | Mint resolved the user by email; email isn't guaranteed unique across providers | Info (belt) | Mint now asserts the minted `user.id` equals the verified caller before returning; also a cheap JWT-shape filter to skip upstream calls on garbage bearers |
| R1 | `check_login_locked` at `signin.js:40` had no try/catch — a network blip there stranded the button on "Signing in…" (a residual cause of earlier hangs) | Robustness | Wrapped; failure → proceed as not-locked |
| C2 | Timesheet switcher cache wasn't user-keyed — a prior user's module list was serveable ~5 min after a non-topbar sign-out | Low | Cache payload now carries + checks the user id |

## Deferred (recommended, not done — deliberate)

- **SSO token rides the URL fragment, and an already-signed-in destination
  abandons it unconsumed (valid ~1h).** On a shared PC this is a leak, amplified
  because `reset-password.html` lets any active session set a new password
  without the old one. Mitigated for kiosks (device-token auth, no switcher).
  **Proper fix is a "pull" model** (broker returns a short-lived `hop_id`; the
  destination redeems it for the token over a POST) which also closes the
  login-CSRF / wrong-identity-on-shared-terminal class. Bigger change — schedule
  it. Interim mitigations: shorten the Supabase magic-link/OTP expiry (dashboard);
  add a re-auth gate on `reset-password.html` for non-recovery sessions.
- **Per-user rate limit on `/sso/mint`** — needs a Cloudflare Rate Limiting rule
  + a per-user counter (KV/Durable Object). A cheap JWT-shape flood filter was
  added; the real limiter is a follow-up.
- **Narrow the mint origin allowlist** from the two-account wildcard to the ~9
  exact origins (LOW; the JWT is the real control, so the allowlist is advisory).
- **CSP breadth (carry-over A7):** vendor `xlsx`/`jspdf` to drop `esm.sh` from
  `script-src`, and pin `connect-src` to the one Supabase project host.
- **Ops:** the service-role key lives on two git-connected Cloudflare workers —
  push access to either repo can exfiltrate it. Add branch protection / PR review
  on both. Verify the archived Xero secrets are deleted on the production worker
  (temporium is confirmed clean — only `SUPABASE_SERVICE_ROLE_KEY`).
- **Turnstile enforcement** is still off in Supabase (carry-over from the last
  audit) — still the single highest-value brute-force control.

## What holds up (checked, sound)

- **Module-access authorization is correct.** All six RPCs re-derive authority
  from `auth.uid()`; a developer can't write another org's grants under a
  spoofed org id; ordinary readers can't be coerced cross-org; deny-by-default
  verified; the registry tables are unreachable to clients (definer RPCs only);
  no dynamic SQL. Migration 165's href UPDATE is idempotent and won't clobber an
  operator-set value.
- **Every prior-audit fix (159–163, `_headers`) is intact**, and this week's
  `signin.js` change was a clean bug-fix, not a regression — the forgeable-success
  problem was not reintroduced.
- **No client XSS or secret exposure.** Module-app switchers build DOM nodes (not
  HTML); the login token never touches the DOM; every receiver strips the URL
  fragment before any awaited call (and fragments never ride `Referer`); the
  schema-replica blanket grant loop is gone; no client-side service-role/SMTP
  material.
