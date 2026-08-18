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

// The "active" week the UI should focus on for the current moment.
//
// Two rollover schedules, distinguished by role:
//
//   Admins (admin/developer):
//     Monday all day still shows last week (extra runway for approvals);
//     Tuesday onwards shows the current week.
//
//   Everyone else (staff, managers):
//     Last week shown until 11:00 Monday local time; from 11:00 Monday
//     onwards shows the current week. Gives staff a few hours buffer on
//     Monday morning to finish off the previous week before the UI flips.
//
// Role is inferred from the most recent cached user context in
// sessionStorage (written by requireAuthed). If no cache exists (first
// page load after sign-in / cache clear), defaults to staff behavior;
// requireAuthed writes the cache early on every page so subsequent
// navigations resolve correctly.
//
// `now` is parameterised so tests/tools can probe specific dates.
// `opts.earlyRollover` lets callers force one branch — useful where the
// role is known explicitly (e.g. an admin-only page can pass `false` to
// suppress the cache lookup).
export function getActiveMonday(now = new Date(), opts = {}) {
  const m = getMonday(now);
  if (now.getDay() !== 1) return m;

  const earlyRollover =
    opts.earlyRollover === undefined ? !cachedRoleIsAdmin() : !!opts.earlyRollover;

  // On Monday: stay on last week unless we're past the staff rollover.
  if (!earlyRollover || now.getHours() < 11) {
    m.setDate(m.getDate() - 7);
  }
  return m;
}

// Reads any ptl-ctx:<auth_uid> entry written by requireAuthed and returns
// the most recent admin-role flag. Returns false if no cache exists.
function cachedRoleIsAdmin() {
  try {
    let best = null;
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (!k || !k.startsWith("ptl-ctx:")) continue;
      const raw = sessionStorage.getItem(k);
      if (!raw) continue;
      const entry = JSON.parse(raw);
      if (entry?.ts && (!best || entry.ts > best.ts)) best = entry;
    }
    return best?.data?.isAdminOrHigher === true;
  } catch {
    return false;
  }
}

// Round a number to at most 2 decimal places and strip trailing zeros.
// Cleans up float-summation noise like 40.00000000000001 → "40", 40.5 → "40.5".
// Format a fractional-hour value as hours + minutes, e.g.
//   0.75 -> "45m",  8 -> "8h",  8.5 -> "8h 30m",  8.33 -> "8h 20m".
// The minute portion is always shown in minutes (never a decimal hour).
// Zero renders as "0" so empty-ish totals stay clean. Minutes are rounded
// to the nearest whole minute.
export function fmtHours(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  const totalMin = Math.round(Math.abs(v) * 60);
  if (totalMin === 0) return "0";
  const sign = v < 0 ? "-" : "";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h && m) return `${sign}${h}h ${m}m`;
  return h ? `${sign}${h}h` : `${sign}${m}m`;
}

// Per PTL policy:
//   - All weekend hours (Sat index 5, Sun index 6) are overtime.
//   - Weekday hours above the daily threshold are overtime for that day.
// `workedByDay` is an array of 7 numbers covering Mon..Sun. Leave hours
// should already be excluded by the caller — paid leave doesn't accrue
// OT under NZ payroll convention. Returns `{ otByDay, otTotal }`.
export function computeOvertime(workedByDay, dailyThreshold = 8) {
  const otByDay = [0, 0, 0, 0, 0, 0, 0];
  let otTotal = 0;
  for (let i = 0; i < 7; i++) {
    const h = Number(workedByDay[i]) || 0;
    const ot = i >= 5 ? h : Math.max(0, h - dailyThreshold);
    otByDay[i] = ot;
    otTotal += ot;
  }
  return { otByDay, otTotal };
}

// Total hours a leave request covers: hours_per_day × number of leave
// days between start and end (inclusive). When skipWeekends is true,
// Sat/Sun are not counted. Mirrors the day-counting the approval RPC
// uses to populate the timesheet.
export function leaveTotalHours(startIso, endIso, hoursPerDay, skipWeekends = true) {
  const perDay = Number(hoursPerDay) || 0;
  if (!startIso || !endIso || perDay <= 0) return 0;
  const start = new Date(startIso + "T00:00:00");
  const end = new Date(endIso + "T00:00:00");
  if (isNaN(start) || isNaN(end) || end < start) return 0;
  let days = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay(); // 0=Sun, 6=Sat
    if (skipWeekends && (dow === 0 || dow === 6)) continue;
    days++;
  }
  return Number((days * perDay).toFixed(2));
}

export function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// An employee is "effectively overhead" when their home department is
// flagged overhead AND they don't carry an explicit rate of any flavour.
// A specific cost/sell rate (custom or via rate_source_department_id)
// signals "this person bills time" and overrides the dept default.
// Used wherever the codebase decides whether someone files a timesheet
// or just appears in the leave-only view.
export function isUserEffectiveOverhead(user, dept) {
  if (!dept?.is_overhead) return false;
  if (user?.rate_source_department_id != null) return false;
  if (user?.cost_rate != null) return false;
  if (user?.sell_rate != null) return false;
  return true;
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
  // Re-floor to local midnight. Without this, crossing a DST boundary
  // (NZ does observe DST) leaves the result at 23:00 or 01:00 of the
  // intended date, which trips downstream date arithmetic that assumes
  // these are pure date values.
  r.setHours(0, 0, 0, 0);
  return r;
}

/* ---------------------------------------------------------------- status constants */

export const TS_STATUS = Object.freeze({
  DRAFT: "draft",
  SUBMITTED: "submitted",
  APPROVED: "approved",
  REJECTED: "rejected",
  EXPORTED: "exported",
});

export const LEAVE_STATUS = Object.freeze({
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
});

// Exported is treated the same as approved + submitted for editor-lock
// purposes: the timesheet is past the point where the employee should
// touch it. Admin override still works (see ADMIN_MODE in timesheet.js).
export function isTsSubmittedOrApproved(status) {
  return status === TS_STATUS.SUBMITTED
      || status === TS_STATUS.APPROVED
      || status === TS_STATUS.EXPORTED;
}

/* ---------------------------------------------------------------- donut */

export function donutSvg({ submitted, total, fillColor = "#BEFA40", emptyColor = "#e8e8e8" }) {
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
 *
 * Cancellation note: this function deliberately does NOT accept an
 * AbortSignal. Cancellation happens at the consumer level via
 * makeLatestOnly's token check — superseded callers ignore the result.
 * Binding the underlying request to the first caller's signal would
 * cancel the shared in-flight promise out from under any second caller
 * who joined it.
 */
export async function fetchWeekDashboardData(sb, orgId, weekStart) {
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
        .select("id, name, department_id, active, cost_rate, sell_rate, rate_source_department_id")
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
      // Chunked by timesheet_id to stay under Supabase's 1000-row select
      // cap. At ~70 staff × ~10 entries a single .in() call sits near the
      // limit; a heavy week pushes over and silently drops rows. 50
      // timesheets per chunk keeps each request well under 1000.
      const CHUNK = 50;
      for (let i = 0; i < tsIds.length; i += CHUNK) {
        const slice = tsIds.slice(i, i + CHUNK);
        const { data, error } = await sb
          .from("timesheet_entries")
          .select("timesheet_id, mon_hours, tue_hours, wed_hours, thu_hours, fri_hours, sat_hours, sun_hours")
          .in("timesheet_id", slice);
        if (error) throw error;
        flagTruncationRisk(data?.length, "Week dashboard hour totals");
        if (data?.length) entries.push(...data);
      }
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

// Detection layer for silent-truncation bugs. Every chunked report passes
// the row count of each fetched batch through this helper. If a single
// batch returns at or above the danger threshold (default 950, below
// Supabase's 1000-row default cap), we've likely hit the limit and may
// have lost rows beyond it. Fires a sticky error banner so the admin
// knows the page is suspect and can contact the developer.
//
// One alert per page load is enough — successive truncated chunks would
// just spam the user — so we track first-fire-per-context via a
// session-scoped set.
const _truncationFired = new Set();
export function flagTruncationRisk(rowCount, contextLabel, threshold = 950) {
  if (!Number.isFinite(rowCount) || rowCount < threshold) return;
  const key = `${contextLabel}@${rowCount}`;
  if (_truncationFired.has(contextLabel)) return;
  _truncationFired.add(contextLabel);
  console.warn(`[truncation-risk] ${contextLabel} returned ${rowCount} rows (threshold ${threshold})`);
  notice(
    `⚠ Data integrity warning: this report may be missing rows ` +
    `(${contextLabel} returned ${rowCount}, near the database row cap). ` +
    `Please contact the developer to raise database limits before relying on this data.`,
    "error",
    { sticky: true },
  );
}

export function debounce(fn, ms = 150) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ---------------------------------------------------------------- password */

export const MIN_PASSWORD_LENGTH = 8;

export function validatePassword(pw) {
  if (!pw || pw.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  return { ok: true };
}

/* ---------------------------------------------------------------- notices */

/** Flash a notice into #notice. Level: info | warn | error | success.
 *  Renders on the top layer (Popover API) so it floats above modal
 *  <dialog>s instead of being buried behind their blurred backdrop. */
export function notice(message, level = "info", { sticky = false } = {}) {
  const el = document.getElementById("notice");
  if (!el) {
    console[level === "error" ? "error" : "log"](message);
    return;
  }
  el.className = `notice ${level}`;
  el.textContent = message;

  // Screen readers announce toasts without focus moving to them. Errors
  // interrupt (assertive); everything else waits its turn (polite).
  el.setAttribute("role", level === "error" ? "alert" : "status");
  el.setAttribute("aria-live", level === "error" ? "assertive" : "polite");

  const usePopover = typeof el.showPopover === "function";
  const dismiss = () => {
    if (usePopover) { try { el.hidePopover(); } catch {} }
    el.classList.add("hidden");
  };

  // Tap/click anywhere on the toast dismisses it immediately.
  if (!el._noticeDismissWired) {
    el._noticeDismissWired = true;
    el.style.cursor = "pointer";
    el.title = "Dismiss";
    el.addEventListener("click", () => {
      clearTimeout(notice._t);
      if (typeof el.hidePopover === "function") { try { el.hidePopover(); } catch {} }
      el.classList.add("hidden");
    });
  }

  if (usePopover) {
    if (el.getAttribute("popover") !== "manual") el.setAttribute("popover", "manual");
    el.classList.remove("hidden");
    // Re-show to bump it to the top of the top layer — so a toast
    // triggered while a dialog is open lands above the dialog.
    try { el.hidePopover(); } catch {}
    try { el.showPopover(); } catch {}
  } else {
    el.classList.remove("hidden");
  }

  clearTimeout(notice._t);
  if (!sticky) {
    // Errors linger longer — they carry information the user has to act
    // on, and 5s was tight for reading an unfamiliar message.
    notice._t = setTimeout(dismiss, level === "error" ? 6500 : 5000);
  }
}

// Skeleton shimmer placeholders for loading states — a content area
// should never sit blank or on a bare "Loading…" while data is in
// flight. Table flavour spans the row; block flavour suits div-rendered
// tables.
export function skeletonRows(cols, count = 3) {
  return Array.from({ length: count }, () =>
    `<tr class="skel-row"><td colspan="${cols}"><span class="skel"></span></td></tr>`
  ).join("");
}

export function skeletonBlock(lines = 4) {
  return `<div style="display:grid;gap:12px;padding:8px 0">${
    Array.from({ length: lines }, () => `<span class="skel"></span>`).join("")
  }</div>`;
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

/* ---------------------------------------------------------------- sortable tables */
//
// Global click-to-sort for every data table in the app. One delegated
// listener — shared.js is imported by every page — so tables rendered at
// any time, including string-rendered ones, sort with zero extra wiring.
//
// Skipped: tables marked data-no-sort (editable grids where row order is
// meaningful), multi-row theads (the clock-vs-timesheet grid), headers
// with their own sort handling (.tc-live-sort on the Live table), and
// empty header cells (action columns).
//
// Cell value: a td's data-sort-value attribute when present (used for
// dates/times whose display text doesn't sort lexically), else trimmed
// text. Numeric-looking values (incl. "7.5h", "45m", "80%") compare
// numerically. Empty / "—" cells always sink to the bottom. Placeholder
// rows (one cell spanning the table) stay pinned at the bottom.

document.addEventListener("click", (e) => {
  const th = e.target.closest("thead th");
  if (!th || th.classList.contains("tc-live-sort")) return;
  const table = th.closest("table");
  if (!table || table.dataset.noSort != null) return;
  const thead = th.closest("thead");
  if (!thead || thead.rows.length !== 1) return;
  if (!th.textContent.trim()) return;
  const tbody = table.tBodies[0];
  if (!tbody || tbody.rows.length < 2) return;

  const col = th.cellIndex;
  const dir = th.dataset.sortDir === "asc" ? "desc" : "asc";
  for (const h of thead.rows[0].cells) delete h.dataset.sortDir;
  th.dataset.sortDir = dir;

  const pinned = [], sortable = [];
  for (const tr of Array.from(tbody.rows)) {
    if (tr.cells.length === 1 && tr.cells[0].colSpan > 1) pinned.push(tr);
    else sortable.push(tr);
  }
  const val = (tr) => {
    const td = tr.cells[col];
    if (!td) return "";
    const v = (td.dataset.sortValue ?? td.textContent).trim();
    return v === "—" ? "" : v;
  };
  const num = (s) => {
    // "8h 30m" / "45m" / "8h" → total minutes, so hour columns sort
    // numerically even though they read as h/m text.
    const hm = s.match(/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?$/i);
    if (hm && (hm[1] != null || hm[2] != null)) {
      return Number(hm[1] || 0) * 60 + Number(hm[2] || 0);
    }
    const cleaned = s.replace(/[,$%]/g, "").replace(/(hrs?|mins?|[hm])$/i, "").trim();
    return cleaned !== "" && !isNaN(cleaned) ? Number(cleaned) : null;
  };
  const sign = dir === "asc" ? 1 : -1;
  sortable.sort((a, b) => {
    const av = val(a), bv = val(b);
    if (!av && !bv) return 0;
    if (!av) return 1;  // empties last in both directions
    if (!bv) return -1;
    const an = num(av), bn = num(bv);
    if (an != null && bn != null) return (an - bn) * sign;
    return av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" }) * sign;
  });
  for (const tr of sortable) tbody.appendChild(tr);
  for (const tr of pinned) tbody.appendChild(tr);
});

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

  // Leave tab: hidden for staff whose type receives no leave at all, but
  // always shown to managers/admins (they need the Team Requests sub-tab).
  // receivesLeave comes from opts when the caller passes it, else the
  // module-level value getUserContext just computed for this user.
  const receivesLeave = (opts.receivesLeave ?? _lastReceivesLeave) !== false;
  const canReviewTeamLeave = canSeeAdminNav || !!opts.isManager;

  const links = [
    { key: "timesheet",  href: "/timesheet.html",   label: "My Timesheets",  show: true },
    { key: "leave",      href: "/leave.html",       label: "Leave",          show: receivesLeave || canReviewTeamLeave },
    { key: "myclock",    href: "/myclock.html",     label: "My Clock",       show: true },
    { key: "department", href: "/department.html",   label: "My Departments", show: !!opts.isManager || role === "developer" },
    { key: "staff",      href: "/staff.html",        label: "Staff",          show: canSeeAdminNav },
    { key: "timeclock",  href: "/timeclock.html",    label: "Clock",          show: isAdminOrDev || !!opts.isClockViewer },
    { key: "admin",      href: "/admin.html",        label: "Admin",          show: isAdminOrDev },
    { key: "configure",  href: "/configure.html",    label: "Configure",      show: role === "developer" },
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
    <div class="app-switcher-slot"></div>
    <div class="brand">
      <img src="/img/ptl-logo.png" class="brand-logo" alt="PTL" />
      <span class="brand-name">Timesheet</span>
    </div>
    <nav class="ready">
      ${links
        .filter((l) => l.show)
        .map(
          (l) =>
            `<a href="${l.href}" class="${opts.active === l.key ? "active" : ""}">${l.label}${
              // Leave gets a red count pill for requests waiting on THIS user
              // to accept — staff were missing manager-raised leave because
              // nothing on the nav pointed at it. Filled in async below.
              l.key === "leave"
                ? `<span class="nav-count-badge" id="nav-leave-badge" hidden></span>`
                // Clock gets the same pill for time-fix requests waiting on a
                // reviewer — the queue lives three sub-tabs deep, so nothing
                // outside the Clock page pointed at it either.
                : l.key === "timeclock"
                  ? `<span class="nav-count-badge" id="nav-clock-badge" hidden></span>`
                  : ""
            }</a>`
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

  // Cross-module switcher, top-left. Populated async so the topbar paints on
  // the first frame regardless — the RPC is never on the critical path.
  mountModuleSwitcher(el.querySelector(".app-switcher-slot"), opts.sb);

  // Leave badge, same fire-and-forget deal — never blocks the paint, and a
  // failure just leaves the pill hidden.
  refreshLeaveBadge(opts.sb).catch((err) =>
    console.warn("leave badge unavailable:", err?.message || err));

  // Only for users who can actually review — the RPC raises otherwise, and the
  // condition mirrors the Clock link's own `show` above.
  if (isAdminOrDev || opts.isClockViewer) {
    refreshClockBadge(opts.sb, opts.currentOrgId).catch((err) =>
      console.warn("clock badge unavailable:", err?.message || err));
  }

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
    // (potentially different-scope) view. Same reasoning for the module
    // list — otherwise the next user briefly sees the previous user's
    // module grants in the switcher.
    invalidateWeekDashboard();
    clearModuleSwitcherCache();
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

/* ------------------------------------------------- leave nav badge -------- */
//
// Red count pill on the Leave tab: how many leave requests are sitting in
// pending_employee waiting for THIS person to accept or decline. Staff kept
// missing requests their manager raised on their behalf because the only
// hint lived inside the Leave page itself.
//
// The user_id filter is load-bearing, not decoration. Admins can read the
// whole org's leave_requests under RLS, so an unfiltered count renders every
// outstanding request in the company on their own nav pill (verified against
// the RLS snapshot: unscoped = 11, correct = 0).
export async function refreshLeaveBadge(sb) {
  const badge = document.getElementById("nav-leave-badge");
  if (!badge) return;  // no Leave link for this user, or topbar not rendered

  if (!sb) {
    const { getSupabase } = await import("/js/supabase-client.js");
    sb = await getSupabase();
  }

  let userId = _lastEmployeeId;
  if (!userId) {
    // No context cached yet (direct load of a page that renders the topbar
    // before getUserContext resolves). Resolve it once ourselves.
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return;
    const { data } = await sb.from("users").select("id")
      .eq("auth_user_id", session.user.id).maybeSingle();
    userId = data?.id ?? null;
  }
  if (!userId) return;  // admin-only account with no users row

  const { count, error } = await sb
    .from("leave_requests")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "pending_employee")
    // Match the Leave page's own filter. A row counted here but hidden there
    // would be a badge the user has no way to clear.
    .is("dismissed_at", null);
  if (error) throw error;

  // A manager's TEAM queue counts too. The Leave page badges "Team Requests"
  // with pending approvals plus change requests, but that pill lives inside the
  // page — so a manager with six requests waiting saw nothing on the nav and had
  // no reason to open Leave at all. Same problem the Clock badge was added for.
  //
  // Both RPCs RAISE for anyone who manages nobody, so failures are swallowed and
  // simply contribute zero rather than being treated as an error: a staff member
  // is not in a broken state, they just have no team.
  let team = 0;
  const orgId = _lastOrgId;
  if (orgId) {
    const [pending, changes] = await Promise.all([
      sb.rpc("list_team_leave_requests", { p_org_id: orgId, p_status: "pending_manager" })
        .then((r) => (r.error ? 0 : (r.data || []).length), () => 0),
      sb.rpc("list_team_leave_change_requests", { p_org_id: orgId })
        .then((r) => (r.error ? 0 : (r.data || []).length), () => 0),
    ]);
    team = pending + changes;
  }

  if (!badge.isConnected) return;  // topbar re-rendered while we awaited
  const mine = count || 0;
  const n = mine + team;
  // The two halves mean different things — one is yours to accept, the other is
  // your team's to review — so the tooltip names them separately rather than
  // presenting a single number the user cannot break down.
  const parts = [];
  if (mine) parts.push(`${mine} waiting for you to accept`);
  if (team) parts.push(`${team} team request${team === 1 ? "" : "s"} to review`);
  setNavBadge(badge, n, parts.join(" · ") || "No leave needs your attention");
}

/* ------------------------------------------------- clock nav badge -------- */
//
// Red count pill on the Clock tab: pending clock-adjustment requests waiting
// for this reviewer. Same problem the Leave badge solved — the queue is the
// sixth sub-tab of the Clock page, so a manager had no reason to look.
//
// Scope comes from the RPC, not from us. list_clock_adjustment_requests
// (migration 146) returns the whole org to an admin/developer or to a clock
// viewer whose clock_view_scope is 'all', and only the caller's own
// departments otherwise — so the count always matches what they can actually
// action. It *raises* for anyone not allowed to review at all, which is why
// this is only called when the Clock link is shown.
export async function refreshClockBadge(sb, orgId) {
  const badge = document.getElementById("nav-clock-badge");
  if (!badge) return;  // no Clock link for this user, or topbar not rendered

  if (!sb) {
    const { getSupabase } = await import("/js/supabase-client.js");
    sb = await getSupabase();
  }

  const org = orgId ?? _lastOrgId;
  if (!org) return;

  const { data, error } = await sb.rpc("list_clock_adjustment_requests", {
    p_org_id: org,
    p_status: "pending",
  });
  if (error) throw error;

  if (!badge.isConnected) return;
  const n = (data || []).length;
  setNavBadge(badge, n,
    `${n} clock time-fix request${n === 1 ? "" : "s"} waiting for your review`);
}

function setNavBadge(badge, n, title) {
  if (n > 0) {
    badge.textContent = String(n);
    if (title) badge.title = title;
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

/* ------------------------------------------------- ERP module switcher ---- */
//
// The nine-dot button at the top-left, listing the other PTL ERP modules this
// user may open. Driven by public.my_allowed_modules() (migration 164), which
// returns registry rows — name, href and description — so one call renders
// the whole menu and module URLs live in the database rather than in a
// per-repo erp-apps.js copy.
//
// FAILS CLOSED. Any error, or an empty result, leaves the slot empty and the
// button never appears. Showing every module on error would be the wrong
// default: this is the list of places someone has been granted, and guessing
// generously would advertise modules they can't use.
//
// Note this is navigation, not enforcement. Each module gates its own entry
// via public.module_access_granted('<key>'); hiding a tile here does not by
// itself stop someone opening that URL directly.

const MODULE_SWITCHER_TTL_MS = 5 * 60_000;
const MODULE_SWITCHER_KEY = "ptl-modules";

// A representative symbol per module, shown at the left of each switcher item
// (muted, then pops to colour on hover). Keyed by the registry module key.
const MODULE_ICONS = {
  timesheet: "🕒",
  partsmaster: "🔩",
  "bom-import": "📐",
  procure: "🛒",
  purchaseorders: "🧾",
  stock: "📦",
  partslogistics: "🚚",
  spares: "🔧",
  map: "🗺️",
};

// The registry href drives BOTH the tile link and the SSO hop destination
// (the freshly-minted one-time login token is appended to it). It is
// developer-writable free text, so validate it here before it is ever used
// as a navigation target: https only, and only the known workers.dev fleet.
// This stops a hostile/typo'd registry row from turning a tile into a
// token-exfiltration link or a javascript: XSS.
const SSO_FLEET_HOST_RE = /^[a-z0-9-]+\.(ethanbrown7619|businessautomation)\.workers\.dev$/;
function ssoDestOk(href) {
  try {
    const u = new URL(href, location.origin);
    return u.protocol === "https:" && SSO_FLEET_HOST_RE.test(u.host);
  } catch { return false; }
}

async function fetchAllowedModules(sb) {
  const client = sb || (await (await import("/js/supabase-client.js")).getSupabase());
  const { data: { session } } = await client.auth.getSession();
  const uid = session?.user?.id ?? null;
  try {
    const cached = sessionStorage.getItem(MODULE_SWITCHER_KEY);
    if (cached) {
      const { data, ts, u } = JSON.parse(cached);
      // Keyed to the user: a cached list from a previous account (sign-out
      // that didn't clear it, expiry, another tab) must never be served.
      if (u === uid && Date.now() - ts < MODULE_SWITCHER_TTL_MS) return data;
    }
  } catch { /* cache unreadable — fall through and refetch */ }

  const { data, error } = await client.rpc("my_allowed_modules");
  if (error) throw error;
  const rows = data || [];
  try {
    sessionStorage.setItem(MODULE_SWITCHER_KEY, JSON.stringify({ data: rows, ts: Date.now(), u: uid }));
  } catch { /* private mode / quota — the menu just refetches next load */ }
  return rows;
}

export function clearModuleSwitcherCache() {
  try { sessionStorage.removeItem(MODULE_SWITCHER_KEY); } catch { /* ignore */ }
}

async function mountModuleSwitcher(slot, sb) {
  if (!slot) return;

  let modules;
  try {
    modules = await fetchAllowedModules(sb);
  } catch (err) {
    console.warn("module switcher unavailable:", err?.message || err);
    return;                       // fail closed
  }
  // One entry is this app itself — no menu worth opening for that alone.
  if (!Array.isArray(modules) || modules.length < 2) return;
  if (!slot.isConnected) return;  // topbar re-rendered while we were awaiting

  const items = modules
    // Drop any registry row whose href isn't a valid fleet https URL — it
    // would otherwise be an unsafe navigation/exfiltration target.
    .filter((m) => m.key === "timesheet" || ssoDestOk(m.href))
    .map((m) => {
      const current = m.key === "timesheet";
      const icon = MODULE_ICONS[m.key] || "▪";
      return `<a class="app-switcher-item${current ? " current" : ""}" role="menuitem"
                 href="${escapeHtml(m.href)}"${current ? ' aria-current="page"' : ""}>
                <span class="app-switcher-icon" aria-hidden="true">${icon}</span>
                <span class="app-switcher-text">
                  <span class="app-name">${escapeHtml(m.name)}</span>
                  <span class="app-desc">${escapeHtml(m.description || "")}</span>
                </span>
              </a>`;
    })
    .join("");

  slot.innerHTML = `
    <div class="app-switcher">
      <button class="app-switcher-btn" type="button" aria-label="Switch module"
              aria-haspopup="true" aria-expanded="false">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="2.5" cy="2.5" r="1.6"/><circle cx="8" cy="2.5" r="1.6"/><circle cx="13.5" cy="2.5" r="1.6"/>
          <circle cx="2.5" cy="8" r="1.6"/><circle cx="8" cy="8" r="1.6"/><circle cx="13.5" cy="8" r="1.6"/>
          <circle cx="2.5" cy="13.5" r="1.6"/><circle cx="8" cy="13.5" r="1.6"/><circle cx="13.5" cy="13.5" r="1.6"/>
        </svg>
      </button>
      <div class="app-switcher-menu" role="menu">${items}</div>
    </div>`;

  const wrap = slot.querySelector(".app-switcher");
  const btn = slot.querySelector(".app-switcher-btn");

  // Plain left-clicks hop via SSO (/sso/mint on this worker) so the
  // destination module signs the user in silently; modified clicks (new tab
  // etc.) keep native behaviour and fall back to the module's own login.
  const menuEl = slot.querySelector(".app-switcher-menu");
  menuEl.addEventListener("click", async (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest("a.app-switcher-item");
    if (!a || a.classList.contains("current")) return;
    e.preventDefault();
    const href = a.href;
    try {
      const client = sb || (await (await import("/js/supabase-client.js")).getSupabase());
      const { data: { session } } = await client.auth.getSession();
      if (!session) { location.href = href; return; }
      // Absolute URL, not "/sso/mint": this frontend is ALSO mirrored on the
      // production businessautomation worker, which has no mint endpoint —
      // temporium is the one SSO broker for the whole fleet (CORS covers
      // both accounts).
      const res = await fetch("https://temporium.ethanbrown7619.workers.dev/sso/mint", {
        method: "POST",
        headers: { authorization: `Bearer ${session.access_token}` },
      });
      const { token_hash } = res.ok ? await res.json() : {};
      // Only ever attach the login token to a validated fleet destination.
      location.href = (token_hash && ssoDestOk(href))
        ? `${href}#ptl-sso=${encodeURIComponent(token_hash)}`
        : href;
    } catch {
      location.href = href;
    }
  });

  const setOpen = (open) => {
    wrap.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", String(open));
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(!wrap.classList.contains("open"));
  });

  // Document-level closers self-remove once this topbar instance is replaced,
  // so repeated renderTopbar() calls don't leak listeners.
  const onDocClick = (e) => {
    if (!wrap.isConnected) return document.removeEventListener("click", onDocClick);
    if (!wrap.contains(e.target)) setOpen(false);
  };
  const onDocKey = (e) => {
    if (!wrap.isConnected) return document.removeEventListener("keydown", onDocKey);
    if (e.key === "Escape") setOpen(false);
  };
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onDocKey);
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

// Stale-while-revalidate: a cache hit is served INSTANTLY (0 network
// round trips on the navigation's critical path) and a background
// refresh rewrites the cache, so permission changes made by an admin
// (manager flag, clock-viewer access, department move) land one page
// navigation later — faster propagation than the old 60s hard TTL gave,
// without ever blocking a page on the network. The TTL is only the
// hard bound for serving without revalidation having caught up.
const USER_CONTEXT_TTL_MS = 5 * 60_000;

// Last-computed "does this user's staff type receive any leave" flag. Stashed
// at module scope so renderTopbar can hide the Leave tab without every page
// having to thread it through — every page calls getUserContext first.
let _lastReceivesLeave = true;

// Last-known users.id for the signed-in caller, stashed for the same reason
// as _lastReceivesLeave: renderTopbar needs it for the Leave nav badge and
// no page threads it through. Null until getUserContext has run once.
let _lastEmployeeId = null;

// Same again for the organisation, needed by the Clock nav badge. Not every
// page passes currentOrgId to renderTopbar (only the ones with the developer
// org switcher do), so the badge falls back to this.
let _lastOrgId = null;

function userContextKey(session) {
  return `ptl-ctx:${session?.user?.id || "anon"}`;
}

// Forced password change (security audit 2026-08, finding A8). This used
// to be checked only in signin.js, so a user issued a temp password could
// skip it by navigating straight to any other page. Enforcing it here
// covers every page that resolves a user context — which is all of them.
//
// Not a server-side control: the temp password is random and delivered
// out of band (migration 140), so there is no attacker-known credential
// to exploit. This stops a user from declining to set their own password,
// which is what the flag is actually for.
const PASSWORD_CHANGE_PATH = "/change-password.html";
const MUST_CHANGE_ALLOWED_PATHS = new Set([
  PASSWORD_CHANGE_PATH,
  "/signin.html",
  "/forgot-password.html",
  "/reset-password.html",
]);

// Fast path only. app_metadata.provider is stamped when the ACCOUNT is
// created, not rewritten per sign-in — and every employee here is created with
// an email identity by an admin before Microsoft is ever linked, so a linked
// user can still read as "email". True is trustworthy; false proves nothing.
// The authority is settle_microsoft_signin() below, which reads
// auth.identities server-side (migration 176).
function isPasswordlessSession(session) {
  const provider = session?.user?.app_metadata?.provider;
  return !!provider && provider !== "email";
}

function enforceMustChangePassword(data, session) {
  if (!data?.mustChangePassword) return data;
  // A Microsoft user is exempt. The flag is set when an admin creates an
  // employee with a temp password (migration 140) and exists to stop someone
  // declining to choose their own — but an Entra user has no password to
  // change and will never use one, so the gate had nothing to ask for and
  // simply bounced them to the password screen on every page, forever.
  //
  // The real resolution happens server-side in fetchFreshUserContext, which
  // clears the flag outright (migration 176). This is the cheap check that
  // catches it without a round trip when the JWT happens to say so.
  //
  // Known and accepted: a user still flagged in a STALE sessionStorage entry
  // gets one bounce to change-password.html before the background revalidate
  // clears it. It self-heals on the next navigation; engineering around it
  // would mean making this function async, which every caller assumes it is
  // not.
  if (isPasswordlessSession(session)) return data;
  if (MUST_CHANGE_ALLOWED_PATHS.has(location.pathname)) return data;
  location.replace(PASSWORD_CHANGE_PATH);
  throw new Error("password change required");
}

export async function getUserContext(sb, session, { force = false } = {}) {
  if (!session) return null;
  const cacheKey = userContextKey(session);
  if (!force) {
    try {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) {
        const { data, ts } = JSON.parse(cached);
        if (Date.now() - ts < USER_CONTEXT_TTL_MS) {
          _lastReceivesLeave = data?.receivesLeave !== false;
          _lastEmployeeId = data?.employee?.id ?? null;
          _lastOrgId =
            data?.adminRow?.organisation_id ?? data?.employee?.organisation_id ?? null;
          // Serve the cache instantly; refresh it in the background so
          // the next navigation sees any permission changes.
          fetchFreshUserContext(sb, session, cacheKey).catch((err) =>
            console.warn("context revalidate failed:", err?.message || err));
          return enforceMustChangePassword(data, session);
        }
      }
    } catch (err) {
      if (err?.message === "password change required") throw err;
      console.warn("getUserContext cache read failed:", err);
    }
  }

  return enforceMustChangePassword(await fetchFreshUserContext(sb, session, cacheKey), session);
}

async function fetchFreshUserContext(sb, session, cacheKey) {
  const [devRes, adminRes, meRes] = await Promise.allSettled([
    sb.rpc("is_developer"),
    sb.from("admins").select("organisation_id, role").eq("user_id", session.user.id).maybeSingle(),
    sb.from("users").select("id, organisation_id, name, is_manager, department_id, can_view_clock_comparison, clock_view_scope, cost_rate, sell_rate, rate_source_department_id, employment_type, must_change_password").eq("auth_user_id", session.user.id).maybeSingle(),
  ]);

  if (devRes.status === "rejected") console.warn("is_developer failed:", devRes.reason);
  if (adminRes.status === "rejected") console.warn("admins lookup failed:", adminRes.reason);
  if (meRes.status === "rejected") console.warn("users self-lookup failed:", meRes.reason);

  const isDeveloper = devRes.status === "fulfilled" && !!devRes.value?.data;
  const adminRow = adminRes.status === "fulfilled" ? (adminRes.value?.data || null) : null;
  const employee = meRes.status === "fulfilled" ? (meRes.value?.data || null) : null;
  const role = adminRow?.role || (isDeveloper ? "developer" : null);

  // Somebody who signs in with Microsoft is never asked to set a password.
  // Only reached when the flag is actually set, so this costs nothing for the
  // people it does not concern — and once it fires the flag is cleared for
  // good, so it costs each affected employee exactly one call, once.
  //
  // The server decides: settle_microsoft_signin() reads auth.identities, which
  // is the only place that knows whether Microsoft is linked (migration 176).
  // Best-effort in both directions — if the RPC is missing (migration not yet
  // applied) or the network blips, we fall through to the existing behaviour
  // and the user is prompted, which is the safe way to be wrong.
  let mustChange = !!employee?.must_change_password;
  if (mustChange) {
    try {
      const { data: settled } = await sb.rpc("settle_microsoft_signin");
      if (settled) mustChange = false;
    } catch (err) {
      console.warn("settle_microsoft_signin failed; keeping the prompt:", err?.message || err);
    }
  }

  // Does this user's staff type receive any leave at all? Read from the org's
  // employment_type_settings (Configure > Staff Types). A type with all three
  // entitlements off (e.g. Contractor by default) receives no leave, so the
  // Leave tab is hidden for them. Defaults to TRUE on any uncertainty
  // (unknown type, missing settings, read error) so we never wrongly hide it.
  let receivesLeave = true;
  try {
    const empType = (employee?.employment_type || "").toLowerCase();
    const orgId = employee?.organisation_id;
    if (orgId && empType) {
      const { data: orgCfg } = await sb.from("organisations")
        .select("employment_type_settings").eq("id", orgId).maybeSingle();
      const cfg = orgCfg?.employment_type_settings?.[empType];
      if (cfg) {
        receivesLeave = !!(cfg.public_holidays || cfg.sick_leave || cfg.annual_leave);
      }
    }
  } catch (err) {
    console.warn("receivesLeave lookup failed; defaulting to visible:", err?.message || err);
  }
  _lastReceivesLeave = receivesLeave;
  _lastEmployeeId = employee?.id ?? null;
  _lastOrgId = adminRow?.organisation_id ?? employee?.organisation_id ?? null;

  const data = {
    isDeveloper,
    adminRow,
    employee,
    isManager: !!employee?.is_manager,
    role,
    isAdminOrHigher: role === "admin" || role === "developer",
    // Clock-comparison-only viewer: gets the Admin nav link, but the
    // admin page hides every tab except Timesheet vs Clock.
    isClockViewer: !!employee?.can_view_clock_comparison,
    // 'all' | 'managed' — when 'managed', the Timeclock page shows only
    // employees in departments this user manages. Admins/devs ignore it.
    clockViewScope: employee?.clock_view_scope === "managed" ? "managed" : "all",
    // False only when the user's staff type has every leave entitlement off.
    receivesLeave,
    // Admin-issued temp password not yet replaced. Enforced in
    // getUserContext() so it applies on every page, not just sign-in.
    // Already false for a Microsoft account — see the settle call above.
    mustChangePassword: mustChange,
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

export async function requireAdmin(sb, { allowManager = true, allowClockViewer = false } = {}) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    location.replace("/signin.html");
    throw new Error("not signed in");
  }

  const ctx = await getUserContext(sb, session);
  const role = ctx.role;
  const canView =
    role === "developer" ||
    role === "admin" ||
    (allowManager && role === "manager") ||
    (allowClockViewer && ctx.isClockViewer);

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
    currentOrgId = ctx.adminRow?.organisation_id || ctx.employee?.organisation_id || null;
  }

  return {
    session,
    isDeveloper: ctx.isDeveloper,
    isManager: ctx.isManager,
    isClockViewer: ctx.isClockViewer,
    adminRow: ctx.adminRow,
    employee: ctx.employee,
    role,
    isAdminOrHigher: ctx.isAdminOrHigher,
    orgs,
    currentOrgId,
  };
}

// Stricter than requireAdmin — refuses admin and manager accounts and only
// admits the developer role. Use on pages that hold settings the operator
// should not be able to change themselves (the Configure page being the
// motivating case).
export async function requireDeveloper(sb) {
  const result = await requireAdmin(sb);
  if (!result.isDeveloper) {
    location.replace("/welcome.html");
    throw new Error("not developer");
  }
  return result;
}
