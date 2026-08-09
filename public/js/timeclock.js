// PTL Timesheet — TimeClock page.
// Two sub-tabs: Live (presence) and Timeclock vs Timesheet (weekly).
// Accessible to admins, developers, managers, and clock-comparison
// viewers. Live polling pauses when the user navigates away from the
// Live sub-tab so we don't spam the database.

import { getSupabase } from "/js/supabase-client.js";
import {
  notice, escapeHtml, renderTopbar, getUserContext,
  DAYS, DAY_LABELS, getActiveMonday, fmtDate, addDays,
  makeLatestOnly,
  fetchWeekDashboardData,
  isUserEffectiveOverhead,
  confirmDialog, promptDialog,
  skeletonBlock, fmtHours,
} from "/js/shared.js";

const sb = await getSupabase();

// Day columns show "7 Aug" (day + short month, no year). Accepts a Date or a
// yyyy-mm-dd string; the string is parsed by parts to avoid any timezone
// shift on a date-only value.
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDayShort(v) {
  if (v == null || v === "") return "";
  if (v instanceof Date) return isNaN(v) ? "" : `${v.getDate()} ${MONTHS_SHORT[v.getMonth()]}`;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  if (m) return `${Number(m[3])} ${MONTHS_SHORT[Number(m[2]) - 1]}`;
  const d = new Date(v);
  return isNaN(d) ? String(v) : `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

// Local Date for a yyyy-mm-dd value. Built from the parts so it lands on
// local midnight — `new Date("2026-08-07")` parses as UTC and can report the
// wrong weekday once NZ is a day ahead.
const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function dayToLocalDate(v) {
  if (v instanceof Date) return isNaN(v) ? null : v;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ""));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function isWeekendDay(v) {
  const d = dayToLocalDate(v);
  if (!d) return false;   // unknown shape — treat as a weekday, never hide it
  const dow = d.getDay();
  return dow === 0 || dow === 6;
}

// "Fri 7 Aug" — the weekday name matters now that unworked days are listed,
// since you're scanning for which day of the week someone was absent.
function fmtDayLabel(v) {
  const d = dayToLocalDate(v);
  const short = fmtDayShort(v);
  return d ? `${DAYS_SHORT[d.getDay()]} ${short}` : short;
}

const { data: { session } } = await sb.auth.getSession();
if (!session) { location.replace("/signin.html"); throw new Error("not signed in"); }

const ctx = await getUserContext(sb, session);
const isAdminOrDev = ctx.isDeveloper || ctx.adminRow?.role === "admin";
const canAccess = isAdminOrDev || ctx.isManager || ctx.isClockViewer;
if (!canAccess) {
  location.replace("/welcome.html");
  throw new Error("not authorised for /timeclock.html");
}

const currentOrgId =
  ctx.adminRow?.organisation_id || ctx.employee?.organisation_id || null;

renderTopbar({
  sb,
  session,
  isDeveloper: ctx.isDeveloper,
  isManager: ctx.isManager,
  isClockViewer: ctx.isClockViewer,
  adminRow: ctx.adminRow,
  orgs: null,
  currentOrgId,
  onOrgChange: () => {},
  active: "timeclock",
});

if (!currentOrgId) {
  notice("No organisation on this account.", "error", { sticky: true });
}

/* ---------------------------------------------------------------- view scope */
//
// A Timeclock viewer can be limited to "managed departments only"
// (users.clock_view_scope = 'managed'); admins/devs always see all. When
// scoped, every sub-tab below filters down to the employees in the
// departments this user is the manager of. This is a display scope for
// trusted managers, not an RLS boundary — the clock RPCs are SECURITY
// DEFINER and still return the whole org; we filter client-side.

const clockScopeMode = isAdminOrDev ? "all" : (ctx.clockViewScope || "all");
// null  => unrestricted ('all'); otherwise the allow-sets for 'managed'.
let clockScope = null;
let clockScopeLoaded = false;

async function loadClockScope() {
  if (clockScopeLoaded) return;
  if (clockScopeMode !== "managed") { clockScope = null; clockScopeLoaded = true; return; }
  const myId = ctx.employee?.id;
  const empty = { deptIds: new Set(), deptNames: new Set(), userIds: new Set(), names: new Set() };
  if (!myId || !currentOrgId) { clockScope = empty; clockScopeLoaded = true; return; }
  try {
    const { data: depts } = await sb.from("departments")
      .select("id, name")
      .eq("organisation_id", currentOrgId)
      .eq("manager_id", myId);
    const deptIds   = new Set((depts || []).map((d) => d.id));
    const deptNames = new Set((depts || []).map((d) => d.name).filter(Boolean));
    let userIds = new Set(), names = new Set();
    if (deptIds.size) {
      // Via clock_roster for the same reason as loadActiveEmployeeRoster:
      // a direct users select is now row-scoped for department leads.
      const { data: us } = await sb.rpc("clock_roster", { p_org_id: currentOrgId });
      const mine = (us || []).filter((u) => deptIds.has(u.department_id));
      userIds = new Set(mine.map((u) => u.id));
      names   = new Set(mine.map((u) => u.name).filter(Boolean));
    }
    clockScope = { deptIds, deptNames, userIds, names };
  } catch (err) {
    console.warn("clock scope load failed; defaulting to no rows:", err?.message || err);
    clockScope = empty;
  }
  clockScopeLoaded = true;
}

const scopeAllowsUserId = (uid)  => !clockScope || clockScope.userIds.has(uid);
const scopeAllowsName   = (name) => !clockScope || clockScope.names.has(name);
const scopeAllowsDeptId = (id)   => !clockScope || clockScope.deptIds.has(id);

/* ------------------------------------------------- panel status pill */

// The report sub-tabs used to render full-width .notice banners for
// their summaries ("42 shifts…", "3 flagged…", errors, no-events notes)
// which crowded the page. Each panel header now has a compact status
// pill on its right instead; this sets its text and tone.
// Tones: info (neutral), ok (green), warn (amber), danger (red).
function setPanelStatus(el, html, tone = "info") {
  if (!el) return;
  el.className = `panel-status ${tone}`;
  el.innerHTML = html;
  // Long messages (load errors) truncate with an ellipsis — keep the
  // full text reachable on hover.
  el.title = el.textContent;
}

/* ---------------------------------------------------------------- sub-tabs */

let tcSubView = "live";

function applySubView() {
  document.querySelectorAll("[data-tc-view]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tcView === tcSubView);
  });
  document.getElementById("tc-live").style.display     = tcSubView === "live"     ? "" : "none";
  document.getElementById("tc-clockvts").style.display = tcSubView === "clockvts" ? "" : "none";
  document.getElementById("tc-flags").style.display    = tcSubView === "flags"    ? "" : "none";
  document.getElementById("tc-full").style.display     = tcSubView === "full"     ? "" : "none";
  document.getElementById("tc-offsite").style.display  = tcSubView === "offsite"  ? "" : "none";
  document.getElementById("tc-adjust").style.display   = tcSubView === "adjust"   ? "" : "none";
  if (tcSubView === "live") {
    startLivePresence();
  } else {
    stopLivePresence();
    if (tcSubView === "clockvts") navLoadClockComparison();
    if (tcSubView === "flags")    navLoadFlagReport();
    if (tcSubView === "full")     navLoadFullReport();
    if (tcSubView === "offsite")  navLoadOffsiteReport();
    if (tcSubView === "adjust")   loadAdjustments();
  }
}

document.querySelectorAll("[data-tc-view]").forEach((btn) => {
  btn.addEventListener("click", () => {
    tcSubView = btn.dataset.tcView;
    applySubView();
  });
});

/* ---------------------------------------------------------------- Live */

let liveTimer = null;
let liveClockTimer = null;

function stopLivePresence() {
  if (liveTimer)      { clearInterval(liveTimer);      liveTimer = null; }
  if (liveClockTimer) { clearInterval(liveClockTimer); liveClockTimer = null; }
}

// Refresh both the employee roster and the visitors-on-site panel together
// so they always reflect the same moment and share one polling cadence.
function refreshLive() {
  loadLivePresence();
  loadVisitorsOnSite();
}

function startLivePresence() {
  stopLivePresence();
  refreshLive();
  liveTimer = setInterval(refreshLive, 30_000);
  const tickClock = () => {
    const el = document.getElementById("tc-live-clock");
    if (el) el.textContent = new Date().toLocaleTimeString();
  };
  tickClock();
  liveClockTimer = setInterval(tickClock, 1000);
}

document.getElementById("tc-live-refresh")?.addEventListener("click", () => refreshLive());

// Status values come from public.org_live_status (Attendium) plus two
// client-side sentinels: "on_leave" (active approved leave for today,
// label carries the leave type) and "not_clocked_in" (active staff with
// no shift today and not on leave). The base RPC statuses are
// exhaustively: on_site | off_site_job | off_site_personal | off_site_break | clocked_out_early.
// The second arg carries break name for off_site_break, or the leave
// type name for on_leave.
function liveStatusLabel(s, detail) {
  switch ((s || "").toLowerCase()) {
    case "on_site":            return { label: "On site",                                               cls: "onsite"  };
    case "off_site_job":       return { label: "Off site (job)",                                        cls: "offsite" };
    case "off_site_personal":  return { label: "Off site (personal)",                                   cls: "offsite" };
    case "off_site_break":     return { label: detail ? `Off site break (${detail})` : "Off site break", cls: "break"   };
    case "clocked_out_early":  return { label: "Clocked out early",                                     cls: "away"    };
    case "on_leave":           return { label: detail || "On leave",                                    cls: "leave"   };
    case "not_clocked_in":     return { label: "Not clocked in",                                        cls: "absent"  };
    default:                   return { label: s || "—",                                                cls: "away"    };
  }
}

function fmtSince(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMin = mins % 60;
  return `${hrs}h ${remMin}m`;
}

// Live presence sort state — persists across 30s refresh ticks so a
// mid-sort refresh doesn't snap the table back to the default. Defaults
// to name ascending so the initial render is the same as before.
let liveSortKey = "name";
let liveSortDir = "asc";
let liveRowsCache = [];
let liveEmpInfoByName = null; // null until first load completes

// Status-tile filter: a set of status classes (onsite/offsite/break/away/
// leave/absent). Empty = show everyone. Clicking a tile toggles its class
// in/out of the set. Persists across the 30s refresh so the view stays put.
const liveStatusFilter = new Set();

// The status class ('onsite' etc.) a live row maps to — same mapping the
// tiles use, so tile selection and row visibility stay in lockstep.
function liveRowCls(r) {
  const detail = r.status === "on_leave" ? r.leave_type : r.break_name;
  return liveStatusLabel(r.status, detail).cls;
}

// Active employee roster — name, department, and employment_type. We use
// this for two things:
//   1. Decorate live rows with employment_type (the RPC doesn't return it).
//   2. Inject rows for active staff who AREN'T in the live RPC result
//      (i.e. haven't clocked in today) so the live view shows the
//      status of every employee, not just present ones.
// Fetched once per page load — these values don't change live.
async function loadActiveEmployeeRoster() {
  if (liveEmpInfoByName || !currentOrgId) return;
  // Roster comes from the clock_roster RPC, not a direct users select:
  // migration 160 narrows what a department lead can read from users to
  // their own reports, which would have left this list half-populated
  // while org_live_status kept returning the whole org. The RPC returns
  // the org-wide roster (no rate columns) to the same three roles the
  // page admits. See 160_narrow_manager_read_scope.sql.
  const [usersRes, deptsRes] = await Promise.all([
    sb.rpc("clock_roster", { p_org_id: currentOrgId }),
    sb.from("departments")
      .select("id, name")
      .eq("organisation_id", currentOrgId),
  ]);
  const deptName = new Map((deptsRes.data || []).map((d) => [d.id, d.name]));
  liveEmpInfoByName = new Map();
  for (const u of (usersRes.data || []).filter((r) => r.active)) {
    if (!u.name) continue;
    liveEmpInfoByName.set(u.name, {
      name: u.name,
      department: u.department_id ? (deptName.get(u.department_id) || "") : "",
      employment_type: u.employment_type || "",
    });
  }
}

function liveStatusRank(s) {
  // Sort priority when ordering by Status: on-site first, then off-site
  // job, then break, clocked-out-early, then not-clocked-in last so
  // active staff bubble up.
  switch ((s || "").toLowerCase()) {
    case "on_site":           return 0;
    case "off_site_job":      return 1;
    case "off_site_break":    return 2;
    case "clocked_out_early": return 3;
    case "on_leave":          return 4;
    case "not_clocked_in":    return 5;
    default:                  return 6;
  }
}

function renderLiveTable() {
  const body = document.getElementById("tc-live-body");
  if (!body) return;

  const filtered = liveStatusFilter.size
    ? liveRowsCache.filter((r) => liveStatusFilter.has(liveRowCls(r)))
    : liveRowsCache;

  if (!filtered.length) {
    const msg = liveRowsCache.length && liveStatusFilter.size
      ? "No employees match the selected status filter."
      : "No active employees.";
    body.innerHTML = `<tr><td colspan="5" class="muted small" style="text-align:center">${msg}</td></tr>`;
    updateLiveSortIndicators();
    return;
  }

  const dir = liveSortDir === "asc" ? 1 : -1;
  const sorted = filtered.slice().sort((a, b) => {
    if (liveSortKey === "status") {
      const r = liveStatusRank(a.status) - liveStatusRank(b.status);
      if (r !== 0) return r * dir;
      return String(a.name || "").localeCompare(String(b.name || "")) * dir;
    }
    if (liveSortKey === "since") {
      // Empty since sorts to the bottom regardless of direction.
      const at = a.since ? new Date(a.since).getTime() : null;
      const bt = b.since ? new Date(b.since).getTime() : null;
      if (at == null && bt == null) return 0;
      if (at == null) return 1;
      if (bt == null) return -1;
      return (at - bt) * dir;
    }
    const av = String(a[liveSortKey] ?? "").toLowerCase();
    const bv = String(b[liveSortKey] ?? "").toLowerCase();
    return av.localeCompare(bv) * dir;
  });

  body.innerHTML = sorted.map((r) => {
    const detail = r.status === "on_leave" ? r.leave_type : r.break_name;
    const { label, cls } = liveStatusLabel(r.status, detail);
    return `<tr>
      <td><span class="tc-live-pill ${cls}">${escapeHtml(label)}</span></td>
      <td>${escapeHtml(r.name || "")}</td>
      <td class="small muted">${escapeHtml(r.department || "")}</td>
      <td class="small">${escapeHtml(r.employment_type || "")}</td>
      <td class="small">${escapeHtml(fmtSince(r.since))}</td>
    </tr>`;
  }).join("");
  updateLiveSortIndicators();
}

function updateLiveSortIndicators() {
  document.querySelectorAll("#tc-live-head .tc-live-sort").forEach((th) => {
    const ind = th.querySelector(".sort-ind");
    if (!ind) return;
    if (th.dataset.sort === liveSortKey) {
      ind.textContent = liveSortDir === "asc" ? " ↑" : " ↓";
      th.classList.add("sorted");
    } else {
      ind.textContent = "";
      th.classList.remove("sorted");
    }
  });
}

document.querySelectorAll("#tc-live-head .tc-live-sort").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (key === liveSortKey) {
      liveSortDir = liveSortDir === "asc" ? "desc" : "asc";
    } else {
      liveSortKey = key;
      liveSortDir = "asc";
    }
    renderLiveTable();
  });
});

async function loadLivePresence() {
  if (!currentOrgId) return;
  const body = document.getElementById("tc-live-body");
  const countsEl = document.getElementById("tc-live-counts");
  try {
    await loadActiveEmployeeRoster();
    await loadClockScope();

    // org_live_status is an RPC in Attendium, not a view, and takes p_org_id
    // explicitly. Since migration 159 it IS gated server-side: the wrapper
    // requires is_admin_of / user_is_dept_manager_in_org /
    // user_can_view_clock_comparison, all pinned to p_org_id. Before 159 it
    // had no check at all and any signed-in user could read any org's clock
    // data (security audit 2026-08, finding A2). The client-side guard at
    // the top of this file is UX; the RPC is the boundary.
    const { data, error } = await sb.rpc("org_live_status", { p_org_id: currentOrgId });
    if (error) throw error;

    // Who's on approved leave today, keyed by name → leave type. Used to
    // show "Sick Leave" etc. instead of "Not clocked in" for people
    // legitimately away. Best-effort: if the RPC isn't deployed yet, the
    // map stays empty and presence falls back to the old behaviour.
    const onLeaveByName = new Map();
    try {
      const { data: leaveRows } = await sb.rpc("org_on_leave_today", {
        p_org_id: currentOrgId,
        p_today: fmtDate(new Date()),
      });
      for (const lr of leaveRows || []) {
        if (lr.name) onLeaveByName.set(lr.name, lr.leave_type_name || "On leave");
      }
    } catch (e) {
      console.warn("org_on_leave_today unavailable:", e?.message || e);
    }

    // Live rows from the RPC, decorated with employment_type from the
    // local roster (the RPC doesn't return it).
    const liveByName = new Map();
    const rows = (data || []).map((r) => {
      const info = liveEmpInfoByName?.get(r.name) || null;
      const row = {
        ...r,
        employment_type: info?.employment_type || "",
      };
      if (r.name) liveByName.set(r.name, row);
      return row;
    });

    // For every active employee NOT in the live RPC result, append a
    // row: "On leave (<type>)" if they have approved leave today,
    // otherwise "Not clocked in". Gives a complete picture of everyone.
    if (liveEmpInfoByName) {
      for (const info of liveEmpInfoByName.values()) {
        if (liveByName.has(info.name)) continue;
        const leaveType = onLeaveByName.get(info.name);
        rows.push({
          name:            info.name,
          department:      info.department,
          employment_type: info.employment_type,
          status:          leaveType ? "on_leave" : "not_clocked_in",
          leave_type:      leaveType || null,
          since:           null,
          break_name:      null,
        });
      }
    }

    // Managed-departments scope: drop everyone outside this viewer's team
    // before counting tiles and rendering rows.
    const scopedRows = clockScope ? rows.filter((r) => scopeAllowsName(r.name)) : rows;

    const buckets = { onsite: 0, offsite: 0, break: 0, away: 0, leave: 0, absent: 0 };
    for (const r of scopedRows) {
      const detail = r.status === "on_leave" ? r.leave_type : r.break_name;
      const { cls } = liveStatusLabel(r.status, detail);
      buckets[cls] = (buckets[cls] || 0) + 1;
    }
    // Guest count comes from loadVisitorsOnSite (separate fetch). Both
    // fetches fire together, and the visitor one usually resolves FIRST
    // — so rendering a bare "—" here would wipe the count it already
    // wrote and leave the tile stuck on the dash. Render the last known
    // count instead; "—" only before the very first visitor result (or
    // after a visitor fetch error). The six employee-status tiles double
    // as row filters; the Guests tile is a separate panel and stays
    // non-interactive.
    const statusTile = (cls, label, count) => {
      const on = liveStatusFilter.has(cls);
      return `<div class="tile ${cls} filterable${on ? " active" : ""}" data-filter="${cls}" role="button" tabindex="0" aria-pressed="${on}"><div class="num">${count}</div><div class="lbl">${label}</div></div>`;
    };
    countsEl.innerHTML =
      statusTile("onsite",  "On site",           buckets.onsite  || 0) +
      statusTile("offsite", "Off site (job)",    buckets.offsite || 0) +
      statusTile("break",   "Off site break",    buckets.break   || 0) +
      statusTile("away",    "Clocked out early", buckets.away    || 0) +
      statusTile("leave",   "On leave",          buckets.leave   || 0) +
      statusTile("absent",  "Not clocked in",    buckets.absent  || 0) +
      `<div class="tile guest"><div class="num" id="tc-guest-tile-num">${lastGuestCount != null ? lastGuestCount : "—"}</div><div class="lbl">Guests on site</div></div>`;
    countsEl.classList.toggle("has-filter", liveStatusFilter.size > 0);

    // Tiles are rebuilt every refresh, so (re)bind toggle handlers here.
    countsEl.querySelectorAll("[data-filter]").forEach((tileEl) => {
      const toggle = () => {
        const cls = tileEl.dataset.filter;
        if (liveStatusFilter.has(cls)) liveStatusFilter.delete(cls);
        else liveStatusFilter.add(cls);
        const on = liveStatusFilter.has(cls);
        tileEl.classList.toggle("active", on);
        tileEl.setAttribute("aria-pressed", String(on));
        countsEl.classList.toggle("has-filter", liveStatusFilter.size > 0);
        renderLiveTable();
      };
      tileEl.addEventListener("click", toggle);
      tileEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      });
    });

    liveRowsCache = scopedRows;
    renderLiveTable();
  } catch (err) {
    console.error("live presence load failed:", err);
    body.innerHTML = `
      <tr><td colspan="5" class="muted small" style="text-align:center;padding:24px">
        Could not load presence data. ${escapeHtml(err.message || "")}
      </td></tr>`;
    countsEl.innerHTML = "";
  }
}

/* ---------------------------------------------------------------- Visitors on site */
//
// The PTL guest sign-in module writes to the SAME Supabase project as
// Timeium. list_present_guests_admin(p_org_id) is a SECURITY DEFINER RPC
// granted to authenticated and gated server-side by is_admin_of, so only
// admins of this org see its rows. Returns:
//   visitor_id, visitor_name, company, host_name, reason, signed_in_at
// Refreshed alongside the employee roster (see refreshLive).

function fmtSignedInAt(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  d.setSeconds(0, 0);
  return d.toLocaleString(undefined, {
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

// Last successful guest count — survives the live-tiles re-render (which
// rebuilds the tile markup) so the number doesn't flash back to "—".
let lastGuestCount = null;

async function loadVisitorsOnSite() {
  if (!currentOrgId) return;
  const body = document.getElementById("tc-visitors-body");
  const countEl = document.getElementById("tc-visitors-count");
  const tileNumEl = document.getElementById("tc-guest-tile-num");
  if (!body) return;
  try {
    const { data, error } = await sb.rpc("list_present_guests_admin", {
      p_org_id: currentOrgId,
    });
    if (error) throw error;

    const rows = data || [];

    lastGuestCount = rows.length;
    if (tileNumEl) tileNumEl.textContent = String(rows.length);
    if (countEl) {
      if (rows.length) {
        countEl.textContent = `${rows.length} on site`;
        countEl.style.display = "";
      } else {
        countEl.style.display = "none";
      }
    }

    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="4" class="muted small" style="text-align:center;padding:16px">No visitors signed in right now.</td></tr>`;
      return;
    }

    // The host placeholder ('—') comes straight from the RPC when no host
    // was recorded; treat it (and blanks) as "no host" for a clean cell.
    const cleanHost = (h) => {
      const v = String(h || "").trim();
      return v && v !== "—" ? v : "";
    };

    body.innerHTML = rows.map((r) => `
      <tr>
        <td>${escapeHtml(r.visitor_name || "")}</td>
        <td class="small muted">${escapeHtml(r.company || "")}</td>
        <td class="small">${escapeHtml(cleanHost(r.host_name))}</td>
        <td class="small">${escapeHtml(fmtSignedInAt(r.signed_in_at))}</td>
      </tr>`).join("");
  } catch (err) {
    console.error("visitors-on-site load failed:", err);
    lastGuestCount = null;
    if (countEl) countEl.style.display = "none";
    if (tileNumEl) tileNumEl.textContent = "—";
    body.innerHTML = `
      <tr><td colspan="4" class="muted small" style="text-align:center;padding:24px">
        Could not load visitor data. ${escapeHtml(err.message || "")}
      </td></tr>`;
  }
}

/* ---------------------------------------------------------------- Timeclock vs Timesheet */

const thisMonday = getActiveMonday();
let cvtWeek = new Date(thisMonday);
let clockTolerance = 0.5;
let lastCvtData = null;

async function loadOrgTolerance() {
  if (!currentOrgId) return;
  const { data } = await sb.from("organisations")
    .select("clock_tolerance_hours")
    .eq("id", currentOrgId).maybeSingle();
  if (data?.clock_tolerance_hours != null) clockTolerance = Number(data.clock_tolerance_hours);
}

// "Short shift" threshold used by the Clock RPC to flag red. Loaded
// once and reused across the Clock-vs-Timesheet and Full report renders.
// Default 8.5 matches the RPC's coalesce default. We need this on the
// client because our recomputed (minute-truncated) hours may cross the
// threshold even when the RPC's second-precision hours don't — and the
// flag in the RPC response was computed from those second-precision
// hours. So if we don't re-derive, the flag and the displayed hours
// disagree (e.g. shows "Short shift" next to "7.50h" with threshold 7.5).
let clockStandardHours = null;
async function loadClockStandard() {
  if (clockStandardHours != null || !currentOrgId) return;
  const { data } = await sb.from("app_settings")
    .select("auto_close_shift_hours")
    .eq("organisation_id", currentOrgId).maybeSingle();
  clockStandardHours = Number(data?.auto_close_shift_hours) || 8.5;
}

// Re-derive the row flag given our recomputed hours. We only override
// 'red' (short shift) — yellow/orange depend on factors we don't
// recompute (auto-close, lateness). If our recomputed hours equal or
// exceed the threshold, suppress 'red'.
function effectiveFlag(originalFlag, recomputedHours) {
  if (originalFlag === "red" && clockStandardHours != null
      && recomputedHours > 0 && recomputedHours >= clockStandardHours) {
    return null;
  }
  return originalFlag;
}

function updateCvtWeekLabel() {
  const end = addDays(cvtWeek, 6);
  document.getElementById("cvt-week-label").textContent =
    `${cvtWeek.toLocaleDateString(undefined, { day: "numeric", month: "short" })} — ${end.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
}

updateCvtWeekLabel();

const navLoadClockComparison = makeLatestOnly((signal) => loadClockComparison(signal));
document.getElementById("cvt-prev").addEventListener("click", () => {
  cvtWeek = addDays(cvtWeek, -7);
  updateCvtWeekLabel();
  navLoadClockComparison();
});
document.getElementById("cvt-next").addEventListener("click", () => {
  cvtWeek = addDays(cvtWeek, 7);
  updateCvtWeekLabel();
  navLoadClockComparison();
});

async function loadClockComparison() {
  if (!currentOrgId) return;
  const tableEl = document.getElementById("cvt-table");
  const summaryEl = document.getElementById("cvt-summary");
  tableEl.innerHTML = skeletonBlock();
  summaryEl.innerHTML = "";

  // Four independent config fetches — batched so the tab pays one round
  // trip of latency instead of four.
  await Promise.all([loadOrgTolerance(), loadClockStandard(), loadUnpaidBreaks(), loadClockScope()]);

  const ws = fmtDate(cvtWeek);
  const dash = await fetchWeekDashboardData(sb, currentOrgId, ws);
  if (!dash) return;

  const allCvtDepts = dash.departments;
  const cvtDeptById = new Map(allCvtDepts.map((d) => [d.id, d]));
  const employees = dash.employees.filter((e) =>
    !isUserEffectiveOverhead(e, cvtDeptById.get(e.department_id))
    && scopeAllowsDeptId(e.department_id));
  const deptMap = {};
  for (const d of allCvtDepts) if (!d.is_overhead) deptMap[d.id] = d.name;
  for (const e of employees) {
    if (!deptMap[e.department_id]) deptMap[e.department_id] = cvtDeptById.get(e.department_id)?.name || "";
  }

  const tsUserMap = {};
  for (const ts of dash.timesheets) tsUserMap[ts.id] = ts.user_id;

  const loggedMap = {};
  for (const e of dash.entries) {
    const uid = tsUserMap[e.timesheet_id];
    if (!uid) continue;
    if (!loggedMap[uid]) loggedMap[uid] = { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 0 };
    for (const d of DAYS) {
      loggedMap[uid][d] += Number(e[`${d}_hours`]) || 0;
    }
  }

  let clockRows = [];
  try {
    const { data, error } = await sb.rpc("weekly_timesheet", {
      p_week_start: ws,
      p_tz: null,
      p_org_id: currentOrgId,
    });
    if (error) throw error;
    clockRows = data || [];
  } catch (err) {
    setPanelStatus(document.getElementById("cvt-summary"),
      `Couldn't load clock data — ${escapeHtml(err.message || "unknown error")}`, "danger");
    tableEl.innerHTML = "";
    return;
  }

  const clockedMap = {};
  for (const row of clockRows) {
    const uid = row.user_id;
    if (!clockedMap[uid]) clockedMap[uid] = {};
    const dayDate = new Date(row.day + "T00:00:00");
    const dayIdx = Math.round((dayDate - cvtWeek) / 86400000);
    if (dayIdx >= 0 && dayIdx < 7) {
      const dayKey = DAYS[dayIdx];
      clockedMap[uid] = clockedMap[uid] || {};
      // Same worked-hours calc as the Full report's Hours column
      // (shiftWorkedCalc) so the two views always agree.
      clockedMap[uid][dayKey] = (clockedMap[uid][dayKey] || 0) + shiftWorkedCalc(row).hrs;
    }
  }

  lastCvtData = { employees: employees || [], deptMap, loggedMap, clockedMap };
  renderCvtTable(lastCvtData);
}

function renderCvtTable({ employees, deptMap, loggedMap, clockedMap }) {
  const tableEl = document.getElementById("cvt-table");
  const summaryEl = document.getElementById("cvt-summary");
  const tolerance = clockTolerance;

  if (!employees.length) {
    tableEl.innerHTML = `<p class="muted small" style="text-align:center">No active employees.</p>`;
    summaryEl.innerHTML = "";
    return;
  }

  const rows = employees.map((emp) => {
    const logged = loggedMap[emp.id] || {};
    const clocked = clockedMap[emp.id] || {};
    const days = DAYS.map((d) => {
      const l = Number(logged[d]) || 0;
      const c = Number(clocked[d]) || 0;
      const diff = Math.abs(c - l);
      return { day: d, logged: l, clocked: c, diff };
    });
    const totalLogged = days.reduce((s, d) => s + d.logged, 0);
    const totalClocked = days.reduce((s, d) => s + d.clocked, 0);
    const totalDiff = Math.abs(totalClocked - totalLogged);
    const hasDiscrepancy = days.some((d) => d.diff > tolerance) || totalDiff > tolerance;
    return { emp, days, totalLogged, totalClocked, totalDiff, hasDiscrepancy };
  });

  const discrepancyCount = rows.filter((r) => r.hasDiscrepancy).length;

  if (discrepancyCount > 0) {
    setPanelStatus(summaryEl,
      `<strong>${discrepancyCount}</strong> of ${employees.length} over the ±${tolerance}h tolerance`, "warn");
  } else {
    setPanelStatus(summaryEl, `All ${employees.length} match (±${tolerance}h)`, "ok");
  }

  function cellClass(diff) {
    if (diff <= tolerance) return "cvt-ok";
    if (diff <= tolerance * 2) return "cvt-warn";
    return "cvt-danger";
  }

  function fmtH(v) {
    return v ? fmtHours(v) : "–";
  }

  const dateCells = DAYS.map((_, i) => fmtDayShort(addDays(cvtWeek, i)));

  tableEl.innerHTML = `
    <table class="cvt-grid small">
      <thead>
        <tr>
          <th rowspan="2" class="cvt-sticky">Employee</th>
          <th rowspan="2" class="cvt-sticky-dept">Dept</th>
          ${DAY_LABELS.map((dl, i) => `<th colspan="2" class="cvt-day-header">${dl}<br><span class="muted" style="font-weight:400">${dateCells[i]}</span></th>`).join("")}
          <th colspan="2" class="cvt-day-header">Total</th>
        </tr>
        <tr>
          ${DAY_LABELS.map(() => `<th class="cvt-sub">Clock</th><th class="cvt-sub">Log</th>`).join("")}
          <th class="cvt-sub">Clock</th><th class="cvt-sub">Log</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((r) => `
          <tr class="${r.hasDiscrepancy ? "cvt-row-flag" : ""}">
            <td class="cvt-sticky">${escapeHtml(r.emp.name)}</td>
            <td class="cvt-sticky-dept muted">${escapeHtml(deptMap[r.emp.department_id] || "")}</td>
            ${r.days.map((d) => `
              <td class="cvt-cell ${cellClass(d.diff)}">${fmtH(d.clocked)}</td>
              <td class="cvt-cell ${cellClass(d.diff)}">${fmtH(d.logged)}</td>
            `).join("")}
            <td class="cvt-cell cvt-total ${cellClass(r.totalDiff)}"><strong>${fmtH(r.totalClocked)}</strong></td>
            <td class="cvt-cell cvt-total ${cellClass(r.totalDiff)}"><strong>${fmtH(r.totalLogged)}</strong></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

/* ---------------------------------------------------------------- Flag report */
//
// The flag column on weekly_timesheet returns null / 'red' / 'yellow' /
// 'orange' per (user, day). This sub-tab pulls the same RPC and lists
// just the rows that came back with a flag set — one line per flagged
// day with the in/out times so the reviewer can see why it was flagged.
//
//   red    = clocked under the org's standard shift length (short shift)
//   yellow = day was auto-closed (forgot to clock out)
//   orange = late vs standard_start + tolerance

let flagWeek = new Date(thisMonday);

function updateFlagWeekLabel() {
  const end = addDays(flagWeek, 6);
  document.getElementById("flag-week-label").textContent =
    `${flagWeek.toLocaleDateString(undefined, { day: "numeric", month: "short" })} — ${end.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
}
updateFlagWeekLabel();

const navLoadFlagReport = makeLatestOnly((signal) => loadFlagReport(signal));
document.getElementById("flag-prev").addEventListener("click", () => {
  flagWeek = addDays(flagWeek, -7);
  updateFlagWeekLabel();
  navLoadFlagReport();
});
document.getElementById("flag-next").addEventListener("click", () => {
  flagWeek = addDays(flagWeek, 7);
  updateFlagWeekLabel();
  navLoadFlagReport();
});

function flagLabel(f) {
  switch ((f || "").toLowerCase()) {
    case "red":    return { label: "Short shift",  cls: "cvt-danger" };
    case "yellow": return { label: "Auto-closed",  cls: "cvt-warn"   };
    case "orange": return { label: "Late",         cls: "cvt-warn"   };
    default:       return { label: f || "Flagged", cls: ""           };
  }
}

// Round a clock timestamp to the NEAREST whole minute. Both the displayed
// In/Out columns and the Raw-hours calc go through this, so the In/Out you
// see always reconciles exactly with Raw (Raw = rounded-out − rounded-in,
// which is a whole number of minutes). Returns NaN for an unparseable iso.
function roundToMinuteMs(iso) {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return NaN;
  return Math.round(t / 60000) * 60000;
}

function fmtClockTime(iso) {
  if (!iso) return "—";
  const ms = roundToMinuteMs(iso);
  if (isNaN(ms)) return "—";
  // Rounded to the nearest minute (see roundToMinuteMs) so HH:MM is shown
  // deterministically and matches what gets fed into Raw below.
  return new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

// The shared Clock RPC computes raw_hours from second-precision timestamps,
// while the UI displays In/Out at HH:MM precision. That mismatch makes the
// Raw column look wrong by up to ~0.02h. We recompute client-side from the
// same timestamps after rounding each end to the nearest minute, so the
// visible In/Out and Raw always reconcile.
function rawHoursFromTimestamps(firstIn, lastOut) {
  if (!firstIn || !lastOut) return 0;
  const inMs  = roundToMinuteMs(firstIn);
  const outMs = roundToMinuteMs(lastOut);
  if (isNaN(inMs) || isNaN(outMs) || outMs <= inMs) return 0;
  return Number(((outMs - inMs) / 3600000).toFixed(2));
}

function finalHoursFromRaw(rawHours, breakMinutes) {
  const breakHrs = (Number(breakMinutes) || 0) / 60;
  return Math.max(0, Number((rawHours - breakHrs).toFixed(2)));
}

// Single source of truth for a shift's worked hours — used by both the
// Full report and the Clock vs Timesheet comparison so the two views
// can never disagree. Worked = raw − unpaid break + early-leave credit,
// rounded to the nearest quarter hour (payroll works in 15-min blocks).
// Breaks count unpaid minutes only — paid breaks are paid time. The
// shared RPC's break_minutes has no paid/unpaid split, so the unpaid
// share is derived from the org's configured break thresholds; falls
// back to total break_minutes (and skips the credit) when the config
// isn't available or the shift is missing an in/out.
function shiftWorkedCalc(r) {
  const raw = rawHoursFromTimestamps(r.first_in, r.last_out);
  const unpaid = (r.first_in && r.last_out) ? unpaidBreakMinutesForRaw(raw) : null;
  const breakMin = unpaid != null ? unpaid : (Number(r.break_minutes) || 0);
  const earlyMin = unpaid != null ? earlyLeaveCreditMinutes(raw) : 0;
  const hrs = Math.round((finalHoursFromRaw(raw, breakMin) + earlyMin / 60) * 4) / 4;
  return { raw, breakMin, hrs };
}

// Clock-vs-Timesheet compares worked hours against logged hours, and
// "worked" excludes only unpaid breaks (paid breaks are paid time, so
// they count as worked). The shared RPC returns total break_minutes
// without a paid/unpaid split, so we re-derive: sum the unpaid-break
// duration for breaks whose trigger threshold this shift exceeded.
let unpaidBreaks = null;
async function loadUnpaidBreaks() {
  if (unpaidBreaks != null || !currentOrgId) return;
  try {
    const { data } = await sb.rpc("clock_unpaid_breaks", { p_org_id: currentOrgId });
    unpaidBreaks = (data || []).map((b) => ({
      duration_minutes:         Number(b.duration_minutes) || 0,
      trigger_hours_into_shift: Number(b.trigger_hours_into_shift) || 0,
    }));
  } catch {
    // Migration 122 may not be applied yet — fall back to assuming all
    // breaks are unpaid (the existing behaviour).
    unpaidBreaks = [];
  }
}

function unpaidBreakMinutesForRaw(rawHours) {
  if (!Array.isArray(unpaidBreaks)) return null;
  let mins = 0;
  for (const b of unpaidBreaks) {
    if (rawHours >= b.trigger_hours_into_shift) mins += b.duration_minutes;
  }
  return mins;
}

// PTL convention: the last 15 minutes of break are taken as leaving
// 15 minutes earlier instead. So when a shift deducted at least 15
// unpaid minutes, credit 15 back to clocked time — the worker skipped
// that slice of break and clocked out sooner. Deliberately not tied
// to a 15-min-duration break existing in config: a single combined
// 30-min unpaid break carries the same entitlement. Once per shift.
function earlyLeaveCreditMinutes(rawHours) {
  if (!Array.isArray(unpaidBreaks)) return 0;
  return unpaidBreakMinutesForRaw(rawHours) >= 15 ? 15 : 0;
}

async function loadFlagReport() {
  if (!currentOrgId) return;
  const tableEl   = document.getElementById("flag-table");
  const summaryEl = document.getElementById("flag-summary");
  tableEl.innerHTML = skeletonBlock();
  summaryEl.innerHTML = "";

  await Promise.all([loadClockStandard(), loadClockScope(), loadUnpaidBreaks()]);
  const ws = fmtDate(flagWeek);
  let rows = [];
  try {
    const { data, error } = await sb.rpc("weekly_timesheet", {
      p_week_start: ws,
      p_tz: null,
      p_org_id: currentOrgId,
    });
    if (error) throw error;
    // Re-derive the flag client-side from the shared worked-hours calc
    // (same as the Full report's Hours column): rows whose credited,
    // quarter-hour-rounded hours meet the standard shouldn't carry 'red'.
    rows = (data || [])
      .filter((r) => scopeAllowsUserId(r.user_id))
      .map((r) => ({
        ...r,
        flag: effectiveFlag(r.flag, shiftWorkedCalc(r).hrs),
      }))
      .filter((r) => r.flag);
  } catch (err) {
    setPanelStatus(summaryEl,
      `Couldn't load flag data — ${escapeHtml(err.message || "unknown error")}`, "danger");
    tableEl.innerHTML = "";
    return;
  }

  if (!rows.length) {
    setPanelStatus(summaryEl, "No flagged shifts this week", "ok");
    tableEl.innerHTML = "";
    return;
  }

  const byFlag = rows.reduce((m, r) => { m[r.flag] = (m[r.flag] || 0) + 1; return m; }, {});
  const summaryParts = [];
  if (byFlag.red)    summaryParts.push(`<strong>${byFlag.red}</strong> short`);
  if (byFlag.yellow) summaryParts.push(`<strong>${byFlag.yellow}</strong> auto-closed`);
  if (byFlag.orange) summaryParts.push(`<strong>${byFlag.orange}</strong> late`);
  setPanelStatus(summaryEl,
    `${rows.length} flagged (${summaryParts.join(" · ")})`, "warn");

  rows.sort((a, b) => {
    if (a.day !== b.day) return a.day < b.day ? -1 : 1;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });

  tableEl.innerHTML = `
    <table class="small">
      <thead>
        <tr>
          <th>Flag</th>
          <th>Day</th>
          <th>Employee</th>
          <th>Department</th>
          <th class="num">First in</th>
          <th class="num">Last out</th>
          <th class="num">Raw h</th>
          <th class="num">Hours</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((r) => {
          const { raw, hrs } = shiftWorkedCalc(r);
          const f = flagLabel(effectiveFlag(r.flag, hrs));
          return `<tr>
            <td><span class="cvt-cell ${f.cls}" style="padding:2px 8px;border-radius:999px;display:inline-block">${escapeHtml(f.label)}</span></td>
            <td class="small">${escapeHtml(fmtDayShort(r.day))}</td>
            <td>${escapeHtml(r.name || "")}</td>
            <td class="small muted">${escapeHtml(r.department || "")}</td>
            <td class="num small">${escapeHtml(fmtClockTime(r.first_in))}</td>
            <td class="num small">${escapeHtml(fmtClockTime(r.last_out))}</td>
            <td class="num small">${(r.first_in && r.last_out) ? fmtHours(raw) : "—"}</td>
            <td class="num"><strong>${(r.first_in && r.last_out) ? fmtHours(hrs) : "—"}</strong></td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  `;
}

/* ---------------------------------------------------------------- Full report */
//
// Every employee, every day this week — clock-in / clock-out / hours.
// Uses the same weekly_timesheet RPC the other tabs do; doesn't filter
// by flag so days with no clock event still appear (just blank).

let fullWeek = new Date(thisMonday);

function updateFullWeekLabel() {
  const end = addDays(fullWeek, 6);
  document.getElementById("full-week-label").textContent =
    `${fullWeek.toLocaleDateString(undefined, { day: "numeric", month: "short" })} — ${end.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
}
updateFullWeekLabel();

const navLoadFullReport = makeLatestOnly((signal) => loadFullReport(signal));
document.getElementById("full-prev").addEventListener("click", () => {
  fullWeek = addDays(fullWeek, -7);
  updateFullWeekLabel();
  navLoadFullReport();
});
document.getElementById("full-next").addEventListener("click", () => {
  fullWeek = addDays(fullWeek, 7);
  updateFullWeekLabel();
  navLoadFullReport();
});

async function loadFullReport() {
  if (!currentOrgId) return;
  const tableEl   = document.getElementById("full-table");
  const summaryEl = document.getElementById("full-summary");
  tableEl.innerHTML = skeletonBlock();
  summaryEl.innerHTML = "";

  await Promise.all([loadClockStandard(), loadClockScope(), loadUnpaidBreaks()]);
  const ws = fmtDate(fullWeek);
  // Days where an auto-closed event happened. Used to promote 'red'
  // (Short shift) to 'yellow' (Auto-closed) in the row render — the
  // shared Clock RPC's flag column picks red first, but for the Full
  // report we want auto-close to take priority.
  let autoClosedSet = new Set();
  try {
    const weekEndExcl = fmtDate(addDays(fullWeek, 7));
    const { data: acRows } = await sb.rpc("clock_auto_closed_days", {
      p_org_id:   currentOrgId,
      p_start:    ws,
      p_end_excl: weekEndExcl,
      p_tz:       null,
    });
    autoClosedSet = new Set((acRows || []).map((r) => `${r.user_id}_${r.day}`));
  } catch {
    // RPC may not exist yet (migration 121 not applied) or caller
    // lacks access — fall through with an empty set so the original
    // RPC-supplied flag still renders.
  }

  // Days each employee was on approved leave, keyed `${user_id}_${day}` like
  // autoClosedSet, valued `{ name, hours }`. Leave accounts for time the clock
  // can't see, so it settles both absence flags in this report: a day with no
  // clock at all renders as the leave type instead of the red "No Clock", and a
  // short shift stops being flagged once the leave hours cover the shortfall.
  //
  // Only 'approved' counts — a request still awaiting a manager (or awaiting
  // the employee's acceptance) isn't leave yet, so those days stay chaseable.
  //
  // Degradation: RLS lets any manager/admin read leave_requests org-wide, but a
  // plain clock-viewer (can_view_clock_comparison without manager status) isn't
  // covered by that policy. They get no error — just their own rows — so other
  // people's absences keep showing "No Clock". Acceptable: the fallback is the
  // pre-existing behaviour, never a wrong label.
  const leaveDays = new Map();
  try {
    const weekEnd = fmtDate(addDays(fullWeek, 6));
    const { data: lvRows, error: lvErr } = await sb
      .from("leave_requests")
      .select("user_id, start_date, end_date, skip_weekends, hours_per_day, leave_types!leave_requests_leave_type_id_fkey ( name )")
      .eq("organisation_id", currentOrgId)
      .eq("status", "approved")
      .lte("start_date", weekEnd)
      .gte("end_date", ws);
    if (lvErr) throw lvErr;
    for (const lv of lvRows || []) {
      // hours_per_day is always hours even for leave types measured in days —
      // it's the figure apply_leave_to_timesheet writes onto the timesheet.
      const entry = {
        name: lv.leave_types?.name || "Leave",
        hours: Number(lv.hours_per_day) || 0,
      };
      // Walk the request's days clamped to this week, stepping a local Date so
      // no yyyy-mm-dd value is ever round-tripped through new Date(string) —
      // that parses as UTC and would land on the wrong day here.
      let d = dayToLocalDate(lv.start_date < ws ? ws : lv.start_date);
      const last = dayToLocalDate(lv.end_date > weekEnd ? weekEnd : lv.end_date);
      if (!d || !last) continue;
      while (d <= last) {
        const dow = d.getDay();
        if (!(lv.skip_weekends && (dow === 0 || dow === 6))) {
          leaveDays.set(`${lv.user_id}_${fmtDate(d)}`, entry);
        }
        d = addDays(d, 1);
      }
    }
  } catch {
    // Caller can't read leave (see above) — absences stay as "No Clock".
  }

  let rows = [];
  try {
    const { data, error } = await sb.rpc("weekly_timesheet", {
      p_week_start: ws,
      p_tz: null,
      p_org_id: currentOrgId,
    });
    if (error) throw error;
    rows = data || [];
  } catch (err) {
    setPanelStatus(summaryEl,
      `Couldn't load clock data — ${escapeHtml(err.message || "unknown error")}`, "danger");
    tableEl.innerHTML = "";
    return;
  }

  // Every weekday shows a row per employee whether they clocked or not — an
  // absence is precisely what this report needs to surface, so a day with no
  // clock-in renders a red "No Clock" instead of silently vanishing. The RPC
  // already returns a filler row for every active user × every day, so this
  // is just a matter of keeping them.
  //
  // Weekends are the exception: nobody is rostered Sat/Sun, so filling those
  // in would add ~110 red rows a week and bury the weekday absences that
  // matter. A weekend day appears only when someone actually clocked.
  const hasClock = (r) => !!(r.first_in || r.last_out);
  const visible = rows.filter(
    (r) => scopeAllowsUserId(r.user_id) && (hasClock(r) || !isWeekendDay(r.day))
  );

  // Summary counts real shifts only — a No Clock row isn't a shift.
  const worked = visible.filter(hasClock);
  if (!visible.length) {
    setPanelStatus(summaryEl, "No employees in scope this week", "info");
    tableEl.innerHTML = "";
    return;
  }

  visible.sort((a, b) => {
    const an = String(a.name || ""); const bn = String(b.name || "");
    if (an !== bn) return an.localeCompare(bn);
    return (a.day || "") < (b.day || "") ? -1 : 1;
  });

  // Break and Hours come from shiftWorkedCalc — the shared worked-hours
  // calc (unpaid-break deduction, early-leave credit, quarter-hour
  // rounding) also used by Clock vs Timesheet, so the views agree. The
  // summary total sums the rounded values so it matches the rows.
  const totalHours = worked.reduce((s, r) => s + shiftWorkedCalc(r).hrs, 0);
  const uniqueEmps = new Set(visible.map((r) => r.user_id)).size;
  // Leave is counted separately from no-clock: the no-clock number is the
  // chase list, so letting leave inflate it would defeat the point.
  const unworked = visible.filter((r) => !hasClock(r));
  const onLeaveCount = unworked.filter((r) => leaveDays.has(`${r.user_id}_${r.day}`)).length;
  const noClockCount = unworked.length - onLeaveCount;
  setPanelStatus(summaryEl,
    `<strong>${worked.length}</strong> shift${worked.length === 1 ? "" : "s"} ·
     <strong>${uniqueEmps}</strong> employee${uniqueEmps === 1 ? "" : "s"} ·
     <strong>${fmtHours(totalHours)}h</strong> total${
       noClockCount
         ? ` · <strong>${noClockCount}</strong> no-clock day${noClockCount === 1 ? "" : "s"}`
         : ""
     }${
       onLeaveCount ? ` · <strong>${onLeaveCount}</strong> on leave` : ""
     }`, "info");

  tableEl.innerHTML = `
    <table class="small">
      <thead>
        <tr>
          <th>Day</th>
          <th>Employee</th>
          <th>Department</th>
          <th class="num">In</th>
          <th class="num">Out</th>
          <th class="num">Raw</th>
          <th class="num">Break</th>
          <th class="num">Hours</th>
          <th>Flag</th>
        </tr>
      </thead>
      <tbody>
        ${visible.map((r) => {
          const { raw, breakMin, hrs } = shiftWorkedCalc(r);
          // No clock events at all: the row exists to flag the absence, so
          // every metric column is a dash. Approved leave explains the
          // absence, so those days get a neutral leave pill instead of the
          // red "No Clock" — nothing to chase up.
          const absent = !hasClock(r);
          const leave = leaveDays.get(`${r.user_id}_${r.day}`) || null;
          let eff = absent ? null : effectiveFlag(r.flag, hrs);
          // Auto-closed takes priority over short-shift in this view.
          if (eff === "red" && autoClosedSet.has(`${r.user_id}_${r.day}`)) {
            eff = "yellow";
          }
          // A part day of leave explains part of a short shift, so add the
          // leave hours back before judging the shortfall: half a day off plus
          // half a day clocked is a full day, not something to chase. If the
          // two together still fall short it stays red — that's a real short
          // shift. Only 'red' is settled this way; auto-closed and late are
          // about *when* the clock fired, which leave says nothing about.
          const leaveCoversShortfall =
            eff === "red" && leave && clockStandardHours != null &&
            hrs + leave.hours >= clockStandardHours;
          if (leaveCoversShortfall) eff = null;
          // Blue leave pill whenever leave is what accounts for the gap.
          const showLeave = leave && (absent || leaveCoversShortfall);
          const f = showLeave
            ? { label: leave.name, cls: "cvt-leave" }
            : absent
              ? { label: "No Clock", cls: "cvt-danger" }
              : (eff ? flagLabel(eff) : null);
          return `<tr${showLeave ? ' class="tc-on-leave"' : (absent ? ' class="tc-no-clock"' : "")}>
            <td class="small">${escapeHtml(fmtDayLabel(r.day))}</td>
            <td>${escapeHtml(r.name || "")}</td>
            <td class="small muted">${escapeHtml(r.department || "")}</td>
            <td class="num small">${escapeHtml(fmtClockTime(r.first_in))}</td>
            <td class="num small">${escapeHtml(fmtClockTime(r.last_out))}</td>
            <td class="num small">${(r.first_in && r.last_out) ? fmtHours(raw) : "—"}</td>
            <td class="num small">${(!absent && breakMin) ? breakMin + "m" : "—"}</td>
            <td class="num"><strong>${(r.first_in && r.last_out) ? fmtHours(hrs) : "—"}</strong></td>
            <td>${f ? `<span class="cvt-cell ${f.cls}" style="padding:2px 8px;border-radius:999px;display:inline-block">${escapeHtml(f.label)}</span>` : ""}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  `;
}

/* ---------------------------------------------------------------- Off-site events */
//
// Reads Attendium's _offsite_report RPC — one row per off-site spell
// (break, off-site job, or clocked-out-early). End date is exclusive
// per the RPC's contract.

let offsiteWeek = new Date(thisMonday);

function updateOffsiteWeekLabel() {
  const end = addDays(offsiteWeek, 6);
  document.getElementById("offsite-week-label").textContent =
    `${offsiteWeek.toLocaleDateString(undefined, { day: "numeric", month: "short" })} — ${end.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
}
updateOffsiteWeekLabel();

const navLoadOffsiteReport = makeLatestOnly((signal) => loadOffsiteReport(signal));
document.getElementById("offsite-prev").addEventListener("click", () => {
  offsiteWeek = addDays(offsiteWeek, -7);
  updateOffsiteWeekLabel();
  navLoadOffsiteReport();
});
document.getElementById("offsite-next").addEventListener("click", () => {
  offsiteWeek = addDays(offsiteWeek, 7);
  updateOffsiteWeekLabel();
  navLoadOffsiteReport();
});

function fmtMins(m) {
  if (m == null) return "—";
  const n = Number(m);
  if (!Number.isFinite(n)) return "—";
  if (n < 60) return `${Math.round(n)}m`;
  const hrs = Math.floor(n / 60);
  const rem = Math.round(n - hrs * 60);
  return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
}

async function loadOffsiteReport() {
  if (!currentOrgId) return;
  const tableEl   = document.getElementById("offsite-table");
  const summaryEl = document.getElementById("offsite-summary");
  tableEl.innerHTML = skeletonBlock();
  summaryEl.innerHTML = "";

  await loadClockScope();
  const start   = fmtDate(offsiteWeek);
  const endExcl = fmtDate(addDays(offsiteWeek, 7));
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  let rows = [];
  try {
    const { data, error } = await sb.rpc("_offsite_report", {
      p_org_id:   currentOrgId,
      p_start:    start,
      p_end_excl: endExcl,
      p_tz:       tz,
    });
    if (error) throw error;
    // This RPC keys by name/department (no user_id), so scope by both.
    rows = (data || []).filter((r) =>
      !clockScope || clockScope.names.has(r.name) || clockScope.deptNames.has(r.department));
  } catch (err) {
    setPanelStatus(summaryEl,
      `Couldn't load off-site data — ${escapeHtml(err.message || "unknown error")}`, "danger");
    tableEl.innerHTML = "";
    return;
  }

  if (!rows.length) {
    setPanelStatus(summaryEl, "No off-site events this week", "info");
    tableEl.innerHTML = "";
    return;
  }

  // Headline counts.
  let breaks = 0, jobs = 0, early = 0, lateBacks = 0;
  for (const r of rows) {
    if ((r.reason || "").startsWith("Break"))         breaks++;
    else if ((r.reason || "") === "Off-site job")     jobs++;
    else if ((r.reason || "") === "Clocked out early") early++;
    if (r.late_back) lateBacks++;
  }
  setPanelStatus(summaryEl,
    `<strong>${rows.length}</strong> event${rows.length === 1 ? "" : "s"} ·
     ${breaks} break${breaks === 1 ? "" : "s"} · ${jobs} job${jobs === 1 ? "" : "s"} · ${early} early${lateBacks ? ` · <strong>${lateBacks}</strong> late back` : ""}`,
    lateBacks ? "warn" : "info");

  rows.sort((a, b) => {
    const aDay = a.day || ""; const bDay = b.day || "";
    if (aDay !== bDay) return aDay < bDay ? -1 : 1;
    const an = String(a.name || ""); const bn = String(b.name || "");
    if (an !== bn) return an.localeCompare(bn);
    return (a.started_at || "") < (b.started_at || "") ? -1 : 1;
  });

  tableEl.innerHTML = `
    <table class="small">
      <thead>
        <tr>
          <th>Day</th>
          <th>Employee</th>
          <th>Department</th>
          <th>Reason</th>
          <th class="num">Started</th>
          <th class="num">Returned</th>
          <th class="num">Actual</th>
          <th class="num">Expected</th>
          <th>Late back?</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((r) => {
          const stillOut = !r.returned_at && r.return_kind === "open";
          const lateCls = r.late_back ? "cvt-danger" : "";
          return `<tr>
            <td class="small">${escapeHtml(fmtDayShort(r.day))}</td>
            <td>${escapeHtml(r.name || "")}</td>
            <td class="small muted">${escapeHtml(r.department || "")}</td>
            <td class="small">${escapeHtml(r.reason || "")}${r.break_paid === true ? ' <span class="small muted">(paid)</span>' : ""}</td>
            <td class="num small">${escapeHtml(fmtClockTime(r.started_at))}</td>
            <td class="num small">${stillOut ? '<span class="small muted">still out</span>' : escapeHtml(fmtClockTime(r.returned_at))}</td>
            <td class="num small">${escapeHtml(fmtMins(r.actual_minutes))}</td>
            <td class="num small">${escapeHtml(fmtMins(r.expected_minutes))}</td>
            <td>${r.late_back ? `<span class="cvt-cell ${lateCls}" style="padding:2px 8px;border-radius:999px;display:inline-block">Late back</span>` : ""}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  `;
}

/* ---------------------------------------------------------------- Adjustments */
//
// Employee clock-time fix requests (migration 146). The list RPC does its
// own permission + scope filtering server-side: admins/devs and 'all'-scope
// clock viewers see the whole org; 'managed'-scope viewers see only
// requests from employees in departments they manage.

const canReviewAdjustments = isAdminOrDev || ctx.isClockViewer;
if (canReviewAdjustments) {
  const tabBtn = document.getElementById("tc-adjust-tab");
  if (tabBtn) tabBtn.style.display = "";
}

function setAdjustCount(n) {
  const el = document.getElementById("tc-adjust-count");
  if (!el) return;
  if (n > 0) { el.textContent = String(n); el.style.display = ""; }
  else el.style.display = "none";
}

function fmtAdjustTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleString(undefined, {
    weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

async function loadAdjustments() {
  if (!currentOrgId || !canReviewAdjustments) return;
  const pendingBody  = document.getElementById("tc-adjust-pending-body");
  const reviewedBody = document.getElementById("tc-adjust-reviewed-body");
  try {
    const { data, error } = await sb.rpc("list_clock_adjustment_requests", {
      p_org_id: currentOrgId,
      p_status: null,
    });
    if (error) throw error;
    const rows = data || [];
    const pending  = rows.filter((r) => r.status === "pending");
    const reviewed = rows.filter((r) => r.status !== "pending")
      .sort((a, b) => (b.reviewed_at || "").localeCompare(a.reviewed_at || ""))
      .slice(0, 20);
    setAdjustCount(pending.length);

    if (!pending.length) {
      pendingBody.innerHTML = `<tr><td colspan="7" class="muted small" style="text-align:center;padding:16px">No pending adjustment requests.</td></tr>`;
    } else {
      pendingBody.innerHTML = pending.map((r) => `
        <tr data-id="${r.id}">
          <td>${escapeHtml(r.employee_name || "")}</td>
          <td class="small muted">${escapeHtml(r.department_name || "")}</td>
          <td><span class="tc-live-pill ${r.event_type === "in" ? "onsite" : "away"}">${r.event_type === "in" ? "In" : "Out"}</span></td>
          <td class="num small">${escapeHtml(fmtAdjustTime(r.original_time))}</td>
          <td class="num small"><strong>${escapeHtml(fmtAdjustTime(r.requested_time))}</strong></td>
          <td class="small muted">${escapeHtml(r.reason || "")}</td>
          <td style="white-space:nowrap;text-align:right">
            <button class="small adjust-approve-btn">Approve</button>
            <button class="ghost small adjust-decline-btn">Decline</button>
          </td>
        </tr>`).join("");

      pendingBody.querySelectorAll(".adjust-approve-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = Number(btn.closest("tr").dataset.id);
          if (!await confirmDialog({
            title: "Approve adjustment",
            message: "Approve this request? The clock event will be updated to the requested time.",
            confirmText: "Approve",
          })) return;
          const { error: e } = await sb.rpc("review_clock_adjustment", {
            p_request_id: id, p_approve: true, p_note: null,
          });
          if (e) return notice(e.message, "error");
          notice("Adjustment approved — clock event updated", "success");
          await loadAdjustments();
        });
      });
      pendingBody.querySelectorAll(".adjust-decline-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = Number(btn.closest("tr").dataset.id);
          const note = await promptDialog({
            title: "Decline adjustment",
            message: "Reason for declining (optional):",
          });
          if (note === null) return;
          const { error: e } = await sb.rpc("review_clock_adjustment", {
            p_request_id: id, p_approve: false, p_note: note || null,
          });
          if (e) return notice(e.message, "error");
          notice("Adjustment declined", "success");
          await loadAdjustments();
        });
      });
    }

    if (!reviewed.length) {
      reviewedBody.innerHTML = `<tr><td colspan="6" class="muted small" style="text-align:center;padding:16px">Nothing reviewed yet.</td></tr>`;
    } else {
      reviewedBody.innerHTML = reviewed.map((r) => `
        <tr>
          <td>${escapeHtml(r.employee_name || "")}</td>
          <td class="small">${r.event_type === "in" ? "In" : "Out"}</td>
          <td class="num small">${escapeHtml(fmtAdjustTime(r.original_time))}</td>
          <td class="num small">${escapeHtml(fmtAdjustTime(r.requested_time))}</td>
          <td><span class="dept-badge ${r.status === "approved" ? "dept-badge-approved" : "dept-badge-rejected"}">${r.status === "approved" ? "Approved" : "Declined"}</span></td>
          <td class="small muted">${escapeHtml(r.review_note || "")}</td>
        </tr>`).join("");
    }
  } catch (err) {
    console.error("adjustments load failed:", err);
    pendingBody.innerHTML = `<tr><td colspan="7" class="muted small" style="text-align:center;padding:16px;color:#c00">${escapeHtml(err.message || "Could not load adjustment requests")}</td></tr>`;
  }
}

// Surface the pending count on the tab as soon as the page loads, so a
// reviewer sitting on the Live tab still sees work waiting. Best-effort:
// if migration 146 isn't applied yet the RPC 404s and the badge stays off.
async function refreshAdjustCountOnBoot() {
  if (!currentOrgId || !canReviewAdjustments) return;
  try {
    const { data } = await sb.rpc("list_clock_adjustment_requests", {
      p_org_id: currentOrgId,
      p_status: "pending",
    });
    setAdjustCount((data || []).length);
  } catch { /* migration not applied yet */ }
}

/* ---------------------------------------------------------------- boot */

applySubView();
refreshAdjustCountOnBoot();
