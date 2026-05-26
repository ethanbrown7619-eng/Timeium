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
} from "/js/shared.js";

const sb = await getSupabase();

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

/* ---------------------------------------------------------------- sub-tabs */

let tcSubView = "live";

function applySubView() {
  document.querySelectorAll("[data-tc-view]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tcView === tcSubView);
  });
  document.getElementById("tc-live").style.display     = tcSubView === "live"     ? "" : "none";
  document.getElementById("tc-clockvts").style.display = tcSubView === "clockvts" ? "" : "none";
  document.getElementById("tc-flags").style.display    = tcSubView === "flags"    ? "" : "none";
  if (tcSubView === "live") {
    startLivePresence();
  } else {
    stopLivePresence();
    if (tcSubView === "clockvts") navLoadClockComparison();
    if (tcSubView === "flags")    navLoadFlagReport();
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

function startLivePresence() {
  stopLivePresence();
  loadLivePresence();
  liveTimer = setInterval(loadLivePresence, 30_000);
  const tickClock = () => {
    const el = document.getElementById("tc-live-clock");
    if (el) el.textContent = new Date().toLocaleTimeString();
  };
  tickClock();
  liveClockTimer = setInterval(tickClock, 1000);
}

document.getElementById("tc-live-refresh")?.addEventListener("click", () => loadLivePresence());

// Status values come from public.org_live_status (Attendium) and are
// exhaustively: on_site | off_site_job | off_site_break | clocked_out_early.
function liveStatusLabel(s, breakName) {
  switch ((s || "").toLowerCase()) {
    case "on_site":            return { label: "On site",                                               cls: "onsite"  };
    case "off_site_job":       return { label: "Off site (job)",                                        cls: "offsite" };
    case "off_site_break":     return { label: breakName ? `On break (${breakName})` : "On break",      cls: "break"   };
    case "clocked_out_early":  return { label: "Clocked out early",                                     cls: "away"    };
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

async function loadLivePresence() {
  if (!currentOrgId) return;
  const body = document.getElementById("tc-live-body");
  const countsEl = document.getElementById("tc-live-counts");
  try {
    // org_live_status is an RPC in Attendium, not a view. Takes p_org_id
    // explicitly and doesn't gate server-side — anyone with a valid
    // session can call it (our clock-viewer / admin UI permission is
    // app-side via the topbar nav).
    const { data, error } = await sb.rpc("org_live_status", { p_org_id: currentOrgId });
    if (error) throw error;

    const rows = (data || []).slice().sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || "")));

    const buckets = { onsite: 0, offsite: 0, break: 0, away: 0 };
    for (const r of rows) {
      const { cls } = liveStatusLabel(r.status, r.break_name);
      buckets[cls] = (buckets[cls] || 0) + 1;
    }
    countsEl.innerHTML = `
      <div class="tile onsite"><div class="num">${buckets.onsite || 0}</div><div class="lbl">On site</div></div>
      <div class="tile offsite"><div class="num">${buckets.offsite || 0}</div><div class="lbl">Off site (job)</div></div>
      <div class="tile break"><div class="num">${buckets.break || 0}</div><div class="lbl">On break</div></div>
      <div class="tile away"><div class="num">${buckets.away || 0}</div><div class="lbl">Clocked out early</div></div>`;

    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="4" class="muted small" style="text-align:center">No active employees.</td></tr>`;
      return;
    }

    body.innerHTML = rows.map((r) => {
      const { label, cls } = liveStatusLabel(r.status, r.break_name);
      return `<tr>
        <td><span class="tc-live-pill ${cls}">${escapeHtml(label)}</span></td>
        <td>${escapeHtml(r.name || "")}</td>
        <td class="small muted">${escapeHtml(r.department || "")}</td>
        <td class="small">${escapeHtml(fmtSince(r.since))}</td>
      </tr>`;
    }).join("");
  } catch (err) {
    console.error("live presence load failed:", err);
    body.innerHTML = `
      <tr><td colspan="4" class="muted small" style="text-align:center;padding:24px">
        Could not load presence data. ${escapeHtml(err.message || "")}
      </td></tr>`;
    countsEl.innerHTML = "";
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
  tableEl.innerHTML = `<p class="muted small" style="text-align:center">Loading…</p>`;
  summaryEl.innerHTML = "";

  await loadOrgTolerance();

  const ws = fmtDate(cvtWeek);
  const dash = await fetchWeekDashboardData(sb, currentOrgId, ws);
  if (!dash) return;

  const allCvtDepts = dash.departments;
  const cvtDeptById = new Map(allCvtDepts.map((d) => [d.id, d]));
  const employees = dash.employees.filter((e) =>
    !isUserEffectiveOverhead(e, cvtDeptById.get(e.department_id)));
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
    tableEl.innerHTML = `
      <div class="notice warn" style="margin:0">
        Could not load clock data. The Attendium clock-in/out system may not be installed on this Supabase project.<br>
        <span class="small">${escapeHtml(err.message || "")}</span>
      </div>`;
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
      clockedMap[uid][dayKey] = (clockedMap[uid][dayKey] || 0) + Number(row.hours || 0);
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

  summaryEl.innerHTML = discrepancyCount > 0
    ? `<div class="notice warn" style="margin:0 0 12px">
        <strong>${discrepancyCount}</strong> of ${employees.length} employee${employees.length !== 1 ? "s" : ""}
        have discrepancies exceeding ${tolerance}h tolerance.
      </div>`
    : `<div class="notice success" style="margin:0 0 12px">
        All ${employees.length} employees match within ${tolerance}h tolerance.
      </div>`;

  function cellClass(diff) {
    if (diff <= tolerance) return "cvt-ok";
    if (diff <= tolerance * 2) return "cvt-warn";
    return "cvt-danger";
  }

  function fmtH(v) {
    return v ? v.toFixed(1) : "–";
  }

  const dateCells = DAYS.map((_, i) => {
    const d = addDays(cvtWeek, i);
    return `${d.getDate()}/${d.getMonth() + 1}`;
  });

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

function fmtClockTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

async function loadFlagReport() {
  if (!currentOrgId) return;
  const tableEl   = document.getElementById("flag-table");
  const summaryEl = document.getElementById("flag-summary");
  tableEl.innerHTML = `<p class="muted small" style="text-align:center">Loading…</p>`;
  summaryEl.innerHTML = "";

  const ws = fmtDate(flagWeek);
  let rows = [];
  try {
    const { data, error } = await sb.rpc("weekly_timesheet", {
      p_week_start: ws,
      p_tz: null,
      p_org_id: currentOrgId,
    });
    if (error) throw error;
    rows = (data || []).filter((r) => r.flag);
  } catch (err) {
    tableEl.innerHTML = `
      <div class="notice warn" style="margin:0">
        Could not load flag data.<br>
        <span class="small">${escapeHtml(err.message || "")}</span>
      </div>`;
    return;
  }

  if (!rows.length) {
    summaryEl.innerHTML = `<div class="notice success" style="margin:0">No flagged shifts this week. Nice.</div>`;
    tableEl.innerHTML = "";
    return;
  }

  const byFlag = rows.reduce((m, r) => { m[r.flag] = (m[r.flag] || 0) + 1; return m; }, {});
  const summaryParts = [];
  if (byFlag.red)    summaryParts.push(`<strong>${byFlag.red}</strong> short`);
  if (byFlag.yellow) summaryParts.push(`<strong>${byFlag.yellow}</strong> auto-closed`);
  if (byFlag.orange) summaryParts.push(`<strong>${byFlag.orange}</strong> late`);
  summaryEl.innerHTML = `<div class="notice warn" style="margin:0">
    ${rows.length} flagged shift${rows.length === 1 ? "" : "s"} (${summaryParts.join(" · ")}).
  </div>`;

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
          const f = flagLabel(r.flag);
          return `<tr>
            <td><span class="cvt-cell ${f.cls}" style="padding:2px 8px;border-radius:999px;display:inline-block">${escapeHtml(f.label)}</span></td>
            <td class="small">${escapeHtml(r.day || "")}</td>
            <td>${escapeHtml(r.name || "")}</td>
            <td class="small muted">${escapeHtml(r.department || "")}</td>
            <td class="num small">${escapeHtml(fmtClockTime(r.first_in))}</td>
            <td class="num small">${escapeHtml(fmtClockTime(r.last_out))}</td>
            <td class="num small">${r.raw_hours != null ? Number(r.raw_hours).toFixed(2) : "—"}</td>
            <td class="num"><strong>${r.hours != null ? Number(r.hours).toFixed(2) : "—"}</strong></td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  `;
}

/* ---------------------------------------------------------------- boot */

applySubView();
