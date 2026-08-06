# PTL Timesheet — Security Posture

## How we defend against breaches, and how we keep confidential data from the wrong eyes

A plain-language guide to the ways applications are most commonly attacked, and
the specific control in the PTL Timesheet system that stops each one — followed by
a detailed account of exactly **who can see what**, because keeping people from
viewing data they shouldn't is as important as keeping attackers out. Written to
be read by non-specialists as well as engineers.

**Our approach is "defense in depth":** we never rely on a single lock. Every
threat below is stopped by more than one layer, so a failure in one place does not
open the door. The system runs on **Supabase** (a managed PostgreSQL database with
built-in authentication) behind **Cloudflare** (global network, encryption, and
DDoS protection), and its security is reviewed by periodic independent audits (most
recently August 2026).

A note on honesty: a few additional layers are being switched on or built, and are
listed plainly in [Being strengthened](#being-strengthened) rather than claimed as
finished. Everything in the numbered sections is in place today.

---

# Part A — Keeping confidential data from the wrong eyes

This is the part of security most people worry about in a payroll and timesheet
system: *can the wrong person see someone's pay, someone else's hours, or another
company's data?* The answer is built on one principle.

## The core principle: the database decides, not the screen

In many systems, a screen simply "hides" the buttons or data a user shouldn't
have — but the data is still sent to their browser, and anyone technical can pull
it back out. **We do not work that way.**

Every sensitive table in our database is protected by **Row-Level Security (RLS)**.
That means PostgreSQL itself checks, on **every single read and write**, whether
*this specific user* is allowed to see or change *this specific row* — before any
data leaves the database. Hiding something in the interface is never our security
boundary; the database is. This holds true even if someone bypasses our app
entirely and calls the data API directly with their own tools: they get back only
the rows the rules permit, and nothing else.

Everything below is a consequence of that one principle.

## Who can see what

**An ordinary employee** can see **only their own** information — their own
timesheets, their own leave requests and balances, their own clock-in/out records,
and their own pay figures. They cannot read a colleague's hours, rates, or leave,
even by manipulating a request.

**A department manager** can see **only their own direct reports** — the specific
people whose department they lead. They do **not** get a view of the whole company,
and they cannot see employees in departments they don't manage. Read access and
edit access are both scoped this way, so a manager can neither view nor alter
anyone outside their team.

**Pay rates (cost and sell rates)** are treated as especially sensitive. They are
confined to the roles that legitimately need them and scoped by the same rules
above — a department lead does not get a window onto the whole organisation's pay
data.

**An organisation administrator** can manage their **own organisation only** —
their staff, jobs, departments, settings and approvals. Their powers stop at the
boundary of their own company.

**A developer** is a deliberately small, highly-trusted role with system-wide
access for maintenance. This role is held by very few people by design, is granted
only by a direct database action (never self-service), and every developer is a
known, named individual.

**Between companies (multi-tenant isolation):** every record is tied to an
organisation, and the rules enforce that boundary on every query. One company
simply cannot read another company's data — this is checked at the database, and
the last remaining cross-company read path was closed in the August 2026 audit.

**Attendance and clock data** (who is on site, who is off site, break overruns,
late-backs) is confidential and access to it is **checked on the server** for each
request — it is available only to administrators, the relevant department lead, or
users explicitly granted the clock-viewing permission, and it is scoped to their
own organisation. A general employee cannot pull the live floor status or the
off-site report, even by calling the underlying function directly. (This was
specifically hardened in the August 2026 audit.)

**Which modules a person can even open** is granted **per department, deny by
default.** A department with no grant sees only the Timesheet; everything else is
locked until an administrator explicitly enables it. Access is re-checked by the
database when a module loads, and — importantly — **a deactivated employee or a
deactivated department loses access automatically**, which matters for clean
offboarding.

**Administrative screens** (the Configure area, module-access matrix, staff
management, integration settings) are restricted to the appropriate admin or
developer role, and — following the core principle — the underlying operations
re-check that role on the server, so the restriction is real and not just a hidden
menu.

**Stored secrets** (mail-server passwords, integration keys) are readable only by
administrators, held in a dedicated access-controlled vault table — never mixed in
with ordinary data and never sent to an employee's browser.

## Why this holds up even against a technical insider

Because the rules live in the database rather than the interface, a curious or
malicious employee gains nothing by "opening the developer tools," replaying a
request with a different ID, or calling the API directly. The database evaluates
their identity and returns only what they're permitted to see. The set of people
who *could* access any given record is therefore small, known, and enforced — not
a matter of trust in the front end.

---

# Part B — Defending against the common breach methods

## 1. Stolen or guessed passwords (brute force & credential stuffing)

**The attack.** An attacker tries thousands of passwords against the login form, or
reuses username/password pairs leaked from other websites.

**How we're protected.**
- **Passwords are never stored in a readable form** — they are one-way hashed with
  bcrypt, so even we cannot see them and guessing is deliberately slow.
- **The login server rate-limits attempts per source**, throttling rapid-fire
  guessing automatically.
- **Every login attempt — success and failure — is logged** for review (see §14),
  and the recorded success is derived on the server from the verified identity, so
  it cannot be faked.
- Admin-issued starter passwords are **random and unique per person**, delivered
  out of band — there is no shared or default password to guess.

*(CAPTCHA and multi-factor authentication add further layers here — see
[Being strengthened](#being-strengthened).)*

## 2. A stolen copy of the database

**The attack.** An attacker obtains a dump of the database and reads everyone's
passwords and secrets.

**How we're protected.** Because passwords are bcrypt-hashed one-way, a stolen
database yields no usable passwords. Sensitive secrets live in an admin-only vault
table, and the powerful service key is never in the database at all.

## 3. SQL injection

**The attack.** An attacker types database commands into an input field to trick
the app into running them.

**How we're protected.** The application **never builds SQL by gluing strings
together.** All access goes through a parameterized query layer and typed, reviewed
database functions; user input is always a value, never executable SQL. The audit
checked specifically for this and found no dynamic SQL.

## 4. Malicious code injected into the page (Cross-Site Scripting, XSS)

**The attack.** An attacker slips a script into the page — e.g. into a name field —
so it runs in a victim's browser and steals their session.

**How we're protected.** Every value displayed is **escaped**, so `<script>` shows
as harmless text. On top of that, a strict **Content-Security-Policy** tells the
browser to **refuse to run any injected or inline script at all** — only our own
reviewed code executes. There is no `eval` or equivalent.

## 5. Seeing or changing data you shouldn't (broken access control)

**The attack.** A signed-in user changes an ID in a request, or calls the API
directly, to reach records that aren't theirs.

**How we're protected.** This is covered in depth in **Part A** — the database
enforces per-row permissions on every read and write, privileged operations
re-check the caller on the server, access is deny-by-default, and the interface is
never the boundary.

## 6. One company reading another's data (multi-tenant leakage)

**How we're protected.** See Part A — every record is organisation-scoped and the
boundary is enforced at the database on every query.

## 7. Clickjacking

**The attack.** An attacker embeds our app invisibly over their own page so a user
clicks "Approve" or "Delete" without realising.

**How we're protected.** The app **refuses to be embedded in any other website**
(`X-Frame-Options: DENY` and `frame-ancestors 'none'`), so browsers will not load
it inside another site's frame.

## 8. Eavesdropping on the connection (man-in-the-middle)

**How we're protected.** All traffic is **encrypted with HTTPS** via Cloudflare,
and **HSTS** forces browsers to only ever connect over encryption.

## 9. Forged requests from another site (CSRF)

**The attack.** A malicious site you visit while logged in silently fires a request
to our app, riding your session.

**How we're protected.** Authentication uses **signed tokens sent explicitly in a
request header**, not ambient cookies — a malicious site cannot read or attach that
token, so it cannot forge an authenticated request as you.

## 10. Hijacked or stale sessions

**How we're protected.** Sessions are **short-lived signed tokens** that expire and
refresh, and signing out clears them. Moving between the PTL tools issues **each app
its own independent session** rather than sharing one, keeping them isolated.

## 11. Compromised third-party code (supply-chain attack)

**How we're protected.** The core security-critical library is **downloaded once,
reviewed, version-pinned, and served from our own site** — not fetched live from a
third party — so it cannot be swapped out from under us. *(Two export helpers still
load from a CDN and are being brought in-house — see
[Being strengthened](#being-strengthened).)*

## 12. Leaked keys and secrets

**How we're protected.** No secrets live in the source code. The one powerful
"master" key exists **only on the server**, never in the browser or the repository.
The keys that *are* sent to the browser are the kind that are **safe to be public
by design** — they grant nothing on their own, because the database's access rules
are the real gate.

## 13. Denial of service

**How we're protected.** The application sits behind **Cloudflare's global
network**, which absorbs volumetric and DDoS attacks at the edge before they reach
the application.

## 14. No way to investigate after an incident (missing audit trail)

**How we're protected.** Login attempts (successes and failures) are logged; data
imports and snapshots are recorded; and because the database enforces permissions,
the set of people who *could* have taken any action is small and known.

## 15. Over-privileged or misusing insiders

**How we're protected.** Access follows **least privilege** with distinct roles —
employee, department manager, organisation admin, developer — each scoped by the
database rules (Part A). Nobody's powers exceed what their role legitimately needs.

---

## Being strengthened {#being-strengthened}

In the spirit of the honesty this document is meant to carry, these layers are in
progress. They *add to* the protections above; they are not the sole defence for
anything.

- **CAPTCHA (Cloudflare Turnstile)** — integrated in the code; enforcement is being
  switched on at the authentication server to further blunt automated
  password-guessing (§1).
- **Multi-factor authentication (MFA)** — planned: an authenticator-app second
  factor, strengthening §1 for privileged accounts in particular.
- **Bringing the last two export libraries in-house** — removing the final
  third-party CDN dependency to fully close §11.
- **Country-level connection blocking** — under evaluation; the correct
  implementation moves the apps to custom domains so Cloudflare's edge firewall
  applies. (Country blocks are readily bypassed with a VPN, so this is a compliance
  signal rather than a primary control.)

---

## In one sentence

The PTL Timesheet does not trust the screen, the network, or the user's browser to
enforce security — **the database itself decides who can see and change every row**,
**encryption protects the connection**, **the browser is told to run only our own
reviewed code**, and **passwords and secrets are never stored or shipped in a form
an attacker could use** — and that design is verified by periodic independent audits.
