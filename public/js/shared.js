// Shared utilities for the Temporium timesheet module.
// Narrow by design — more helpers land here as later units ship.

/* ---------------------------------------------------------------- dates */

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function getMonday(d) {
  const dt = new Date(d);
  const day = dt.getDay();
  const diff = dt.getDate() - day + (day === 0 ? -6 : 1);
  dt.setDate(diff);
  dt.setHours(0, 0, 0, 0);
  return dt;
}

export function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function fmtShortDate(d) {
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

export function fmtDMY(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

export function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/* ---------------------------------------------------------------- status constants */

export const TS_STATUS = Object.freeze({
  DRAFT: "draft",
  SUBMITTED: "submitted",
  APPROVED: "approved",
  REJECTED: "rejected",
});

export const LEAVE_STATUS = Object.freeze({
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
});

export function isTsSubmittedOrApproved(status) {
  return status === TS_STATUS.SUBMITTED || status === TS_STATUS.APPROVED;
}

/* ---------------------------------------------------------------- donut */

export function donutSvg({ submitted, total, fillColor = "#c2ff00", emptyColor = "#e8e8e8" }) {
  const pct = total === 0 ? 0 : submitted / total;
  const radius = 70;
  const circumference = 2 * Math.PI * radius;
  const filled = circumference * pct;
  const empty = circumference - filled;
  return `
    <svg viewBox="0 0 200 200" class="donut-svg">
      <circle cx="100" cy="100" r="${radius}" fill="none" stroke="${emptyColor}" stroke-width="18" />
      <circle cx="100" cy="100" r="${radius}" fill="none" stroke="${fillColor}" stroke-width="18"
        stroke-dasharray="${filled} ${empty}"
        stroke-dashoffset="${circumference * 0.25}"
        stroke-linecap="round"
        style="transition: stroke-dasharray 0.6s ease" />
      <text x="100" y="92" text-anchor="middle" class="donut-num">${submitted}/${total}</text>
      <text x="100" y="116" text-anchor="middle" class="donut-pct">${Math.round(pct * 100)}%</text>
    </svg>
  `;
}

/* ---------------------------------------------------------------- async utils */

/**
 * Wraps an async loader so only the most recent call renders. Older
 * in-flight calls resolve to undefined. Use to dedupe rapid prev/next clicks.
 *
 * If `fn` accepts an AbortSignal, the wrapper passes a fresh controller to
 * each call and aborts it when a newer call supersedes it, so the underlying
 * HTTP requests are cancelled rather than just discarded on the client side.
 */
export function makeLatestOnly(fn) {
  let token = 0;
  let activeController = null;
  return async (...args) => {
    if (activeController) activeController.abort();
    const controller = new AbortController();
    activeController = controller;
    const myToken = ++token;
    let result;
    try {
      result = await fn(controller.signal, ...args);
    } catch (err) {
      // Swallow errors that belong to a superseded call: either a newer
      // invocation has bumped `token`, or this one was explicitly aborted.
      // Both are expected control flow, not lost-error territory — the
      // caller already moved on.
      if (myToken !== token || controller.signal.aborted) return undefined;
      throw err;
    }
    if (myToken !== token) return undefined;
    return result;
  };
}

const dashboardCache = new Map();
const dashboardInFlight = new Map();
const DASHBOARD_TTL_MS = 30 * 1000;
const DASHBOARD_CACHE_MAX = 50;

// LRU eviction: Map preserves insertion order, so the first key is the
// least recently set. Re-insert (delete-then-set) on cache hits to
// promote, then evict the oldest if we're over the bound. Stops a long
// dev session that switches orgs from accumulating thousands of entries.
function rememberDashboardEntry(key, entry) {
  if (dashboardCache.has(key)) dashboardCache.delete(key);
  dashboardCache.set(key, entry);
  while (dashboardCache.size > DASHBOARD_CACHE_MAX) {
    const oldestKey = dashboardCache.keys().next().value;
    dashboardCache.delete(oldestKey);
  }
}

export function invalidateWeekDashboard(orgId, weekStart) {
  if (orgId == null && weekStart == null) {
    dashboardCache.clear();
    return;
  }
  if (weekStart == null) {
    for (const k of [...dashboardCache.keys()]) {
      if (k.startsWith(`${orgId}:`)) dashboardCache.delete(k);
    }
    return;
  }
  dashboardCache.delete(`${orgId}:${weekStart}`);
}

/**
 * Fetches the data the admin and department dashboards both need for a given
 * week. Returns active employees + departments (manager-aware), all
 * timesheets in that week, a userId→ts map, an entries list, and a
 * tsId→totalHours map. Cached for 30s by `${orgId}:${weekStart}`.
 *
 * Callers do their own scoping (e.g. department.js filters to managed
 * departments). Cache invalidation lives at submit/approve/reject sites
 * via invalidateWeekDashboard.
 */
export async function fetchWeekDashboardData(sb, orgId, weekStart, { signal } = {}) {
  if (!orgId || !weekStart) return null;
  const key = `${orgId}:${weekStart}`;
  const cached = dashboardCache.get(key);
  if (cached && Date.now() - cached.ts < DASHBOARD_TTL_MS) {
    // Promote to most-recently-used in the LRU.
    rememberDashboardEntry(key, cached);
    return cached.data;
  }

  // Two concurrent callers (e.g. tab switch firing while a nav-click is still
  // in flight) should share a single fetch instead of doubling the load.
  // The shared fetch deliberately does NOT bind to the first caller's
  // AbortSignal: if it did and that caller was then superseded via
  // makeLatestOnly, the second caller (still latest) would receive an
  // aborted promise that they never consented to. makeLatestOnly cancels
  // at the consumer level (token check); the underlying request runs to
  // completion and serves both callers from the cache.
  const inFlight = dashboardInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = (async () => {
    const [empRes, deptRes, tsRes] = await Promise.all([
      sb.from("users")
        .select("id, name, department_id, active")
        .eq("organisation_id", orgId)
        .eq("active", true)
        .order("name"),
      sb.from("departments")
        .select("id, name, manager_id, is_overhead, active")
        .eq("organisation_id", orgId)
        .order("name"),
      sb.from("timesheets")
        .select("id, user_id, status")
        .eq("organisation_id", orgId)
        .eq("week_start", weekStart),
    ]);

    const employees = empRes.data || [];
    const departments = deptRes.data || [];
    const timesheets = tsRes.data || [];

    const timesheetsByUserId = {};
    for (const ts of timesheets) timesheetsByUserId[ts.user_id] = ts;

    const tsIds = timesheets.map((t) => t.id);
    const hoursByTsId = {};
    let entries = [];
    if (tsIds.length) {
      const { data } = await sb
        .from("timesheet_entries")
        .select("timesheet_id, mon_hours, tue_hours, wed_hours, thu_hours, fri_hours, sat_hours, sun_hours")
        .in("timesheet_id", tsIds);
      entries = data || [];
      for (const e of entries) {
        const sum = DAYS.reduce((s, d) => s + (Number(e[`${d}_hours`]) || 0), 0);
        hoursByTsId[e.timesheet_id] = (hoursByTsId[e.timesheet_id] || 0) + sum;
      }
    }

    const data = { employees, departments, timesheets, timesheetsByUserId, entries, hoursByTsId };
    rememberDashboardEntry(key, { data, ts: Date.now() });
    return data;
  })();

  dashboardInFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    // Always clear so a failed request doesn't poison the in-flight slot
    // and prevent retries.
    dashboardInFlight.delete(key);
  }
}

export function debounce(fn, ms = 150) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ---------------------------------------------------------------- password */

export const MIN_PASSWORD_LENGTH = 12;

export function validatePassword(pw) {
  if (!pw || pw.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  return { ok: true };
}

/* ---------------------------------------------------------------- notices */

/** Flash a notice into #notice. Level: info | warn | error | success. */
export function notice(message, level = "info", { sticky = false } = {}) {
  const el = document.getElementById("notice");
  if (!el) {
    console[level === "error" ? "error" : "log"](message);
    return;
  }
  el.className = `notice ${level}`;
  el.textContent = message;
  el.classList.remove("hidden");
  if (!sticky) {
    clearTimeout(notice._t);
    notice._t = setTimeout(() => el.classList.add("hidden"), 5000);
  }
}

/* ---------------------------------------------------------------- dialogs */

export function confirmDialog({ title, message, confirmText = "Confirm", cancelText = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "shared-dialog";
    dlg.innerHTML = `
      <div style="padding:24px;width:min(95vw,420px)">
        <h2 style="margin:0 0 12px">${escapeHtml(title)}</h2>
        <p style="margin:0 0 20px">${escapeHtml(message)}</p>
        <div class="row-flex" style="gap:8px;justify-content:flex-end">
          <button class="ghost" data-action="cancel">${escapeHtml(cancelText)}</button>
          <button class="${danger ? "danger" : "primary"}" data-action="confirm">${escapeHtml(confirmText)}</button>
        </div>
      </div>`;
    document.body.appendChild(dlg);
    const finish = (value) => {
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    dlg.addEventListener("click", (e) => {
      const action = e.target?.dataset?.action;
      if (action) finish(action === "confirm");
    });
    dlg.addEventListener("cancel", () => finish(false));
    dlg.showModal();
  });
}

export function promptDialog({ title, message = "", defaultValue = "", placeholder = "", confirmText = "OK", cancelText = "Cancel" }) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "shared-dialog";
    dlg.innerHTML = `
      <form method="dialog" style="padding:24px;width:min(95vw,420px)">
        <h2 style="margin:0 0 12px">${escapeHtml(title)}</h2>
        ${message ? `<p style="margin:0 0 12px">${escapeHtml(message)}</p>` : ""}
        <input type="text" name="value" value="${escapeHtml(defaultValue)}" placeholder="${escapeHtml(placeholder)}"
          style="width:100%;margin:0 0 20px" autofocus />
        <div class="row-flex" style="gap:8px;justify-content:flex-end">
          <button class="ghost" type="button" data-action="cancel">${escapeHtml(cancelText)}</button>
          <button class="primary" type="submit" data-action="confirm">${escapeHtml(confirmText)}</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);
    const finish = (value) => {
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    dlg.querySelector("[data-action=cancel]").addEventListener("click", () => finish(null));
    dlg.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const value = dlg.querySelector("input[name=value]").value;
      finish(value);
    });
    dlg.addEventListener("cancel", () => finish(null));
    dlg.showModal();
  });
}

/* ---------------------------------------------------------------- escape */

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ---------------------------------------------------------------- topbar */

/**
 * Render the shared top-bar. Target: <header class="topbar" id="topbar"></header>.
 * Pages pass `active` to highlight the current section.
 *
 * @param {object}  opts
 * @param {object}  opts.session        Supabase session
 * @param {boolean} opts.isDeveloper
 * @param {object|null} opts.adminRow   The caller's admins row (or null)
 * @param {Array}   opts.orgs           All orgs (developers only) or null
 * @param {number}  opts.currentOrgId
 * @param {function(number):void} opts.onOrgChange
 * @param {"admin"|"staff"|""} opts.active
 */
export function renderTopbar(opts) {
  const el = document.getElementById("topbar");
  if (!el) return;

  const role = opts.adminRow?.role || (opts.isDeveloper ? "developer" : null);
  const canSeeAdminNav =
    role === "admin" || role === "manager" || role === "developer";

  const isAdminOrDev = role === "admin" || role === "developer";

  const links = [
    { key: "timesheet",  href: "/timesheet.html",   label: "My Timesheets",  show: true },
    { key: "department", href: "/department.html",   label: "My Departments", show: !!opts.isManager || isAdminOrDev },
    { key: "staff",      href: "/staff.html",        label: "Staff",          show: canSeeAdminNav },
    { key: "admin",      href: "/admin.html",        label: "Admin",          show: isAdminOrDev },
    { key: "configure",  href: "/configure.html",    label: "Configure",      show: isAdminOrDev },
    { key: "settings",   href: "/settings.html",     label: "Settings",       show: true },
  ];

  const orgSwitcher =
    opts.isDeveloper && Array.isArray(opts.orgs)
      ? `<select id="org-switcher">
            ${opts.orgs
              .map(
                (o) =>
                  `<option value="${o.id}"${o.id === opts.currentOrgId ? " selected" : ""}>${
                    escapeHtml(o.name)
                  }${o.active ? "" : " (inactive)"}</option>`
              )
              .join("")}
          </select>`
      : "";

  // Render the entire topbar in one place. Pages can leave the element empty
  // and we'll fill it; pages that pre-populated it (legacy) are overwritten.
  el.innerHTML = `
    <div class="brand">
      <span class="brand-logo" aria-hidden="true">ptl</span>
      <span class="brand-name">Timesheet</span>
    </div>
    <nav class="ready">
      ${links
        .filter((l) => l.show)
        .map(
          (l) =>
            `<a href="${l.href}" class="${opts.active === l.key ? "active" : ""}">${l.label}</a>`
        )
        .join("")}
    </nav>
    <div class="grow"></div>
    <div class="topbar-user ready">
      ${orgSwitcher}
      <span class="who">${escapeHtml(opts.session?.user?.email || "")}</span>
      <a href="#" id="signout-link" class="muted">Sign out</a>
    </div>
  `;

  if (orgSwitcher && typeof opts.onOrgChange === "function") {
    document
      .getElementById("org-switcher")
      .addEventListener("change", (e) => opts.onOrgChange(Number(e.target.value)));
  }

  document.getElementById("signout-link").addEventListener("click", async (e) => {
    e.preventDefault();
    clearUserContextCache();
    // Wipe the dashboard data cache too. If a different operator signs in
    // on the same browser before the 30s TTL elapses, they'd otherwise see
    // the previous user's cached dashboard rendered against their own
    // (potentially different-scope) view.
    invalidateWeekDashboard();
    if (opts.sb) {
      await opts.sb.auth.signOut();
    } else {
      const { getSupabase } = await import("/js/supabase-client.js");
      const sb = await getSupabase();
      await sb.auth.signOut();
    }
    location.replace("/signin.html");
  });
}

/* ---------------------------------------------------------------- router */
//
// Called after sign-in or sign-up succeeds. Runs the idempotent employee
// claim RPC so that any pending roster linkage is picked up, then redirects
// to the right landing page for whatever role the session turned out to be.

export async function routeAfterAuth(sb) {
  // Run claim, dev check, and admins lookup in parallel — none depend on each other.
  const [claimRes, devRes, adminRes] = await Promise.allSettled([
    sb.rpc("claim_employee_by_email"),
    sb.rpc("is_developer"),
    sb.from("admins").select("role").maybeSingle(),
  ]);

  if (claimRes.status === "rejected") console.warn("claim_employee_by_email failed, continuing", claimRes.reason);
  if (devRes.status === "rejected") console.warn("is_developer failed, continuing", devRes.reason);
  if (adminRes.status === "rejected") console.warn("admins lookup failed, continuing", adminRes.reason);

  const claim = claimRes.status === "fulfilled" ? claimRes.value?.data : null;
  const isDeveloper = devRes.status === "fulfilled" && !!devRes.value?.data;
  const adminRow = adminRes.status === "fulfilled" ? adminRes.value?.data : null;

  const isPrivileged = isDeveloper || !!adminRow;
  const isLinked = !!claim?.claimed || !!claim?.already_linked;

  if (isPrivileged || isLinked) {
    location.replace("/timesheet.html");
    return;
  }

  // Fallback: check if user already has an employee record
  try {
    const { data: { session } } = await sb.auth.getSession();
    const { data } = await sb.from("users").select("id").eq("auth_user_id", session.user.id).maybeSingle();
    if (data) {
      location.replace("/timesheet.html");
      return;
    }
  } catch (err) {
    console.warn("post-auth users self-lookup failed:", err);
  }

  location.replace("/welcome.html?unlinked=1");
}

/* ---------------------------------------------------------------- auth */
//
// Resolve the current user's role context. Three independent queries run in
// parallel and are cached in sessionStorage for 5 minutes so navigating
// between pages doesn't re-fetch them.
//
// Pages that just need the basic role context call getUserContext().
// Admin/staff pages that also need org switching call requireAdmin().

const USER_CONTEXT_TTL_MS = 5 * 60_000;

function userContextKey(session) {
  return `ptl-ctx:${session?.user?.id || "anon"}`;
}

export async function getUserContext(sb, session, { force = false } = {}) {
  if (!session) return null;
  const cacheKey = userContextKey(session);
  if (!force) {
    try {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) {
        const { data, ts } = JSON.parse(cached);
        if (Date.now() - ts < USER_CONTEXT_TTL_MS) return data;
      }
    } catch (err) {
      console.warn("getUserContext cache read failed:", err);
    }
  }

  const [devRes, adminRes, meRes] = await Promise.allSettled([
    sb.rpc("is_developer"),
    sb.from("admins").select("organisation_id, role").eq("user_id", session.user.id).maybeSingle(),
    sb.from("users").select("id, organisation_id, name, is_manager, department_id").eq("auth_user_id", session.user.id).maybeSingle(),
  ]);

  if (devRes.status === "rejected") console.warn("is_developer failed:", devRes.reason);
  if (adminRes.status === "rejected") console.warn("admins lookup failed:", adminRes.reason);
  if (meRes.status === "rejected") console.warn("users self-lookup failed:", meRes.reason);

  const isDeveloper = devRes.status === "fulfilled" && !!devRes.value?.data;
  const adminRow = adminRes.status === "fulfilled" ? (adminRes.value?.data || null) : null;
  const employee = meRes.status === "fulfilled" ? (meRes.value?.data || null) : null;
  const role = adminRow?.role || (isDeveloper ? "developer" : null);

  const data = {
    isDeveloper,
    adminRow,
    employee,
    isManager: !!employee?.is_manager,
    role,
    isAdminOrHigher: role === "admin" || role === "developer",
  };

  try {
    sessionStorage.setItem(cacheKey, JSON.stringify({ data, ts: Date.now() }));
  } catch (err) {
    console.warn("getUserContext cache write failed:", err);
  }
  return data;
}

export function clearUserContextCache(session) {
  try {
    if (session) sessionStorage.removeItem(userContextKey(session));
    else {
      // Wipe every key with our prefix when no session is given (e.g., sign-out).
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const k = sessionStorage.key(i);
        if (k && k.startsWith("ptl-ctx:")) sessionStorage.removeItem(k);
      }
    }
  } catch (err) {
    console.warn("clearUserContextCache failed:", err);
  }
}

export async function requireAdmin(sb, { allowManager = true } = {}) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    location.replace("/signin.html");
    throw new Error("not signed in");
  }

  const ctx = await getUserContext(sb, session);
  const role = ctx.role;
  const canView =
    role === "developer" || role === "admin" || (allowManager && role === "manager");

  if (!canView) {
    location.replace("/welcome.html");
    throw new Error("not admin");
  }

  // Resolve the list of orgs the caller can act on, and the current selection.
  let orgs = null;
  let currentOrgId;
  if (ctx.isDeveloper) {
    const { data: allOrgs, error } = await sb
      .from("organisations")
      .select("id, name, slug, active")
      .order("id");
    if (error) console.warn("organisations lookup failed:", error);
    orgs = allOrgs || [];
    // Renamed from temporium-dev-org-id; fall back for one release so
    // existing dev sessions keep their selection.
    const saved = Number(
      localStorage.getItem("ptl-dev-org-id") ||
      localStorage.getItem("temporium-dev-org-id")
    );
    currentOrgId = orgs.find((o) => o.id === saved)?.id || orgs[0]?.id || null;
  } else {
    currentOrgId = ctx.adminRow?.organisation_id || null;
  }

  return {
    session,
    isDeveloper: ctx.isDeveloper,
    isManager: ctx.isManager,
    adminRow: ctx.adminRow,
    employee: ctx.employee,
    role,
    isAdminOrHigher: ctx.isAdminOrHigher,
    orgs,
    currentOrgId,
  };
}
