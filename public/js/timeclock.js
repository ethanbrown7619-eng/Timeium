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
  if (tcSubView === "live") {
    startLivePresence();
  } else {
    stopLivePresence();
    navLoadClockComparison();
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

function liveStatusLabel(s) {
  switch ((s || "").toLowerCase()) {
    case "on_site":
    case "onsite":           return { label: "On site",        cls: "onsite"  };
    case "off_site_job":
    case "offsite_job":
    case "off_site":         return { label: "Off site (job)", cls: "offsite" };
    case "break":
    case "on_break":         return { label: "On break",       cls: "break"   };
    default:                 return { label: s || "Away",      cls: "away"    };
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
    const { data, error } = await sb
      .from("org_live_status")
      .select("*")
      .eq("organisation_id", currentOrgId);
    if (error) throw error;

    const rows = (data || []).slice().sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || "")));

    const buckets = { onsite: 0, offsite: 0, break: 0, away: 0 };
    for (const r of rows) {
      const { cls } = liveStatusLabel(r.status);
      buckets[cls] = (buckets[cls] || 0) + 1;
    }
    countsEl.innerHTML = `
      <div class="tile onsite"><div class="num">${buckets.onsite || 0}</div><div class="lbl">On site</div></div>
      <div class="tile offsite"><div class="num">${buckets.offsite || 0}</div><div class="lbl">Off site (job)</div></div>
      <div class="tile break"><div class="num">${buckets.break || 0}</div><div class="lbl">On break</div></div>
      <div class="tile away"><div class="num">${buckets.away || 0}</div><div class="lbl">Away</div></div>`;

    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="5" class="muted small" style="text-align:center">No active employees.</td></tr>`;
      return;
    }

    body.innerHTML = rows.map((r) => {
      const { label, cls } = liveStatusLabel(r.status);
      const since = r.since || r.status_since || r.last_event_at;
      const dept = r.department || r.department_name || "";
      const lastEvent = r.last_event_type
        ? `${r.last_event_type}${r.last_event_at ? " · " + new Date(r.last_event_at).toLocaleString() : ""}`
        : "";
      return `<tr>
        <td><span class="tc-live-pill ${cls}">${escapeHtml(label)}</span></td>
        <td>${escapeHtml(r.name || "")}</td>
        <td class="small muted">${escapeHtml(dept)}</td>
        <td class="small">${escapeHtml(fmtSince(since))}</td>
        <td class="small muted">${escapeHtml(lastEvent)}</td>
      </tr>`;
    }).join("");
  } catch (err) {
    console.error("live presence load failed:", err);
    body.innerHTML = `
      <tr><td colspan="5" class="muted small" style="text-align:center;padding:24px">
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

/* ---------------------------------------------------------------- boot */

applySubView();
