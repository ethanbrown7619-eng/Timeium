// PTL Timesheet Admin page.
// Tabs: Dashboard (donut charts) | Infusion Export (xlsx generation).

import { getSupabase } from "/js/supabase-client.js";
import { notice, escapeHtml, renderTopbar, requireAdmin } from "/js/shared.js";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";

const sb = await getSupabase();
const ctx = await requireAdmin(sb);
let currentOrgId = ctx.currentOrgId;

renderTopbar({
  session: ctx.session,
  isDeveloper: ctx.isDeveloper,
  isManager: ctx.isManager,
  adminRow: ctx.adminRow,
  orgs: ctx.orgs,
  currentOrgId,
  onOrgChange: (id) => {
    currentOrgId = id;
    localStorage.setItem("temporium-dev-org-id", String(id));
    if (activeTab === "dashboard") loadDashboard();
    if (activeTab === "clockvts") loadClockComparison();
  },
  active: "admin",
});

if (!currentOrgId) {
  notice("No organisation on this account — contact a developer.", "error", { sticky: true });
}

/* ---------------------------------------------------------------- helpers */

const DAYS = ["mon","tue","wed","thu","fri","sat","sun"];
const DAY_LABELS = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];

function getMonday(d) {
  const dt = new Date(d);
  const day = dt.getDay();
  const diff = dt.getDate() - day + (day === 0 ? -6 : 1);
  dt.setDate(diff);
  dt.setHours(0, 0, 0, 0);
  return dt;
}
function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function fmtDMY(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

const thisMonday = getMonday(new Date());

/* ---------------------------------------------------------------- tabs */

let activeTab = "dashboard";

document.querySelectorAll("[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-tab]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    activeTab = btn.dataset.tab;
    document.getElementById("tab-dashboard").style.display    = activeTab === "dashboard"   ? "" : "none";
    document.getElementById("tab-clockvts").style.display    = activeTab === "clockvts"    ? "" : "none";
    document.getElementById("tab-infusion").style.display    = activeTab === "infusion"    ? "" : "none";
    document.getElementById("tab-leavereport").style.display = activeTab === "leavereport" ? "" : "none";
    if (activeTab === "clockvts") loadClockComparison();
    if (activeTab === "infusion") loadInfusionStatus();
    if (activeTab === "leavereport") loadLeaveReport();
  });
});

/* ================================================================
 * Dashboard tab
 * ================================================================ */

let dashWeek = new Date(thisMonday);

function updateDashWeekLabel() {
  const end = addDays(dashWeek, 6);
  document.getElementById("week-label").textContent =
    `${dashWeek.toLocaleDateString(undefined, { day: "numeric", month: "short" })} — ${end.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
}
updateDashWeekLabel();

document.getElementById("dash-prev").addEventListener("click", () => {
  dashWeek = addDays(dashWeek, -7);
  updateDashWeekLabel();
  loadDashboard();
});
document.getElementById("dash-next").addEventListener("click", () => {
  dashWeek = addDays(dashWeek, 7);
  updateDashWeekLabel();
  loadDashboard();
});

function renderDonut(containerId, submitted, total, colorFill, colorEmpty) {
  const el = document.getElementById(containerId);
  const pct = total === 0 ? 0 : submitted / total;
  const radius = 70;
  const circumference = 2 * Math.PI * radius;
  const filled = circumference * pct;
  const empty = circumference - filled;

  el.innerHTML = `
    <svg viewBox="0 0 200 200" class="donut-svg">
      <circle cx="100" cy="100" r="${radius}" fill="none" stroke="${colorEmpty}" stroke-width="18" />
      <circle cx="100" cy="100" r="${radius}" fill="none" stroke="${colorFill}" stroke-width="18"
        stroke-dasharray="${filled} ${empty}"
        stroke-dashoffset="${circumference * 0.25}"
        stroke-linecap="round"
        style="transition: stroke-dasharray 0.6s ease" />
      <text x="100" y="92" text-anchor="middle" class="donut-num">${submitted}/${total}</text>
      <text x="100" y="116" text-anchor="middle" class="donut-pct">${Math.round(pct * 100)}%</text>
    </svg>
  `;
}

async function loadDashboard() {
  if (!currentOrgId) return;

  const ws = fmtDate(dashWeek);

  const [empRes, deptRes, tsRes] = await Promise.all([
    sb.from("users").select("id, name, department_id, active").eq("organisation_id", currentOrgId).eq("active", true).order("name"),
    sb.from("departments").select("id, name, active").eq("organisation_id", currentOrgId).eq("active", true).order("name"),
    sb.from("timesheets").select("id, user_id, status").eq("organisation_id", currentOrgId).eq("week_start", ws),
  ]);

  const employees = empRes.data || [];
  const departments = deptRes.data || [];
  const timesheets = tsRes.data || [];

  const tsMap = {};
  for (const ts of timesheets) tsMap[ts.user_id] = ts;

  const tsIds = timesheets.map((t) => t.id);
  let hoursMap = {};
  if (tsIds.length) {
    const { data: entries } = await sb
      .from("timesheet_entries")
      .select("timesheet_id, mon_hours, tue_hours, wed_hours, thu_hours, fri_hours, sat_hours, sun_hours")
      .in("timesheet_id", tsIds);
    for (const e of entries || []) {
      const sum = DAYS.reduce((s, d) => s + (Number(e[`${d}_hours`]) || 0), 0);
      hoursMap[e.timesheet_id] = (hoursMap[e.timesheet_id] || 0) + sum;
    }
  }

  const submittedEmps = employees.filter((e) => {
    const ts = tsMap[e.id];
    return ts && (ts.status === "submitted" || ts.status === "approved");
  });
  renderDonut("emp-donut", submittedEmps.length, employees.length, "#c2ff00", "#e8e8e8");
  document.getElementById("emp-legend").innerHTML = `
    <span class="legend-item"><span class="legend-dot" style="background:#c2ff00"></span> Submitted (${submittedEmps.length})</span>
    <span class="legend-item"><span class="legend-dot" style="background:#e8e8e8;border:1px solid #ccc"></span> Not submitted (${employees.length - submittedEmps.length})</span>
  `;

  const deptSubmitted = departments.filter((d) => {
    const members = employees.filter((e) => e.department_id === d.id);
    if (members.length === 0) return false;
    return members.every((e) => {
      const ts = tsMap[e.id];
      return ts && (ts.status === "submitted" || ts.status === "approved");
    });
  });
  renderDonut("dept-donut", deptSubmitted.length, departments.length, "#1a56c7", "#e8e8e8");
  document.getElementById("dept-legend").innerHTML = `
    <span class="legend-item"><span class="legend-dot" style="background:#1a56c7"></span> All submitted (${deptSubmitted.length})</span>
    <span class="legend-item"><span class="legend-dot" style="background:#e8e8e8;border:1px solid #ccc"></span> Pending (${departments.length - deptSubmitted.length})</span>
  `;

  const body = document.getElementById("emp-body");
  if (!employees.length) {
    body.innerHTML = `<tr><td colspan="4" class="muted small" style="text-align:center">No active employees.</td></tr>`;
    return;
  }

  const deptName = (id) => departments.find((d) => d.id === id)?.name || "";

  body.innerHTML = employees.map((e) => {
    const ts = tsMap[e.id];
    const hours = ts ? (hoursMap[ts.id] || 0) : 0;

    let badge, badgeClass;
    if (ts?.status === "approved") {
      badge = "Approved";
      badgeClass = "dept-badge dept-badge-approved";
    } else if (ts && (ts.status === "submitted" || ts.status === "approved")) {
      badge = "Submitted";
      badgeClass = "dept-badge dept-badge-submitted";
    } else if (ts?.status === "draft") {
      badge = "Draft";
      badgeClass = "dept-badge dept-badge-draft";
    } else {
      badge = "Not submitted";
      badgeClass = "dept-badge dept-badge-none";
    }

    return `
      <tr>
        <td>${escapeHtml(e.name)}</td>
        <td class="muted small">${escapeHtml(deptName(e.department_id))}</td>
        <td><span class="${badgeClass}">${badge}</span></td>
        <td class="small">${hours ? hours + "h" : ""}</td>
      </tr>`;
  }).join("");
}

/* ================================================================
 * Timesheet vs Clock tab
 * ================================================================ */

let cvtWeek = new Date(thisMonday);

function updateCvtWeekLabel() {
  const end = addDays(cvtWeek, 6);
  document.getElementById("cvt-week-label").textContent =
    `${cvtWeek.toLocaleDateString(undefined, { day: "numeric", month: "short" })} — ${end.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
}

updateCvtWeekLabel();

document.getElementById("cvt-prev").addEventListener("click", () => {
  cvtWeek = addDays(cvtWeek, -7);
  updateCvtWeekLabel();
  loadClockComparison();
});
document.getElementById("cvt-next").addEventListener("click", () => {
  cvtWeek = addDays(cvtWeek, 7);
  updateCvtWeekLabel();
  loadClockComparison();
});

let lastCvtData = null;

async function loadClockComparison() {
  if (!currentOrgId) return;
  const tableEl = document.getElementById("cvt-table");
  const summaryEl = document.getElementById("cvt-summary");
  tableEl.innerHTML = `<p class="muted small" style="text-align:center">Loading…</p>`;
  summaryEl.innerHTML = "";

  const ws = fmtDate(cvtWeek);

  // Load timesheet logged hours
  const { data: employees } = await sb
    .from("users")
    .select("id, name, department_id, active")
    .eq("organisation_id", currentOrgId)
    .eq("active", true)
    .order("name");

  const { data: departments } = await sb
    .from("departments")
    .select("id, name")
    .eq("organisation_id", currentOrgId);

  const deptMap = {};
  for (const d of departments || []) deptMap[d.id] = d.name;

  // Get timesheet entries for logged hours
  const { data: timesheets } = await sb
    .from("timesheets")
    .select("id, user_id")
    .eq("organisation_id", currentOrgId)
    .eq("week_start", ws);

  const tsUserMap = {};
  const tsIds = [];
  for (const ts of timesheets || []) {
    tsUserMap[ts.id] = ts.user_id;
    tsIds.push(ts.id);
  }

  // Sum logged hours per user per day
  const loggedMap = {};
  if (tsIds.length) {
    const { data: entries } = await sb
      .from("timesheet_entries")
      .select("timesheet_id, mon_hours, tue_hours, wed_hours, thu_hours, fri_hours, sat_hours, sun_hours")
      .in("timesheet_id", tsIds);
    for (const e of entries || []) {
      const uid = tsUserMap[e.timesheet_id];
      if (!uid) continue;
      if (!loggedMap[uid]) loggedMap[uid] = { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 0 };
      for (const d of DAYS) {
        loggedMap[uid][d] += Number(e[`${d}_hours`]) || 0;
      }
    }
  }

  // Call weekly_timesheet RPC for clocked hours
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

  // Map clocked hours: { userId: { dayIndex: hours } }
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

  // Build per-employee comparison
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

/* ================================================================
 * Infusion Export tab
 * ================================================================ */

let infWeek = new Date(thisMonday);
let infRows = [];
let infSubmittedCount = 0;
let infTotalEmps = 0;
let approvalWorkflow = "manager_then_admin";

let clockTolerance = 0.5;

async function loadOrgSettings() {
  if (!currentOrgId) return;
  try {
    const { data } = await sb
      .from("organisations")
      .select("approval_workflow, clock_tolerance_hours")
      .eq("id", currentOrgId)
      .maybeSingle();
    approvalWorkflow = data?.approval_workflow || "manager_then_admin";
    if (data?.clock_tolerance_hours != null) clockTolerance = Number(data.clock_tolerance_hours);
  } catch {}
}

function updateInfusionWeekLabel() {
  const end = addDays(infWeek, 6);
  document.getElementById("inf-week-label").textContent =
    `${infWeek.toLocaleDateString(undefined, { day: "numeric", month: "short" })} — ${end.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
}

async function loadInfusionStatus() {
  const barsEl = document.getElementById("inf-status-bars");
  if (!currentOrgId) { barsEl.innerHTML = ""; return; }

  const ws = fmtDate(infWeek);

  const [empRes, deptRes, tsRes] = await Promise.all([
    sb.from("users").select("id, department_id, active").eq("organisation_id", currentOrgId).eq("active", true),
    sb.from("departments").select("id, name, active").eq("organisation_id", currentOrgId).eq("active", true),
    sb.from("timesheets").select("id, user_id, status").eq("organisation_id", currentOrgId).eq("week_start", ws),
  ]);

  const employees = empRes.data || [];
  const departments = deptRes.data || [];
  const timesheets = tsRes.data || [];

  const tsMap = {};
  for (const ts of timesheets) tsMap[ts.user_id] = ts;

  infTotalEmps = employees.length;
  infSubmittedCount = employees.filter((e) => {
    const ts = tsMap[e.id];
    return ts && (ts.status === "submitted" || ts.status === "approved");
  }).length;

  const empPct = infTotalEmps === 0 ? 0 : Math.round((infSubmittedCount / infTotalEmps) * 100);
  const allSubmitted = infSubmittedCount === infTotalEmps && infTotalEmps > 0;

  let html = `
    <div class="inf-bar-group">
      <div class="row-flex" style="gap:8px;margin-bottom:4px">
        <span class="small" style="font-weight:600">Employees submitted</span>
        <div class="grow"></div>
        <span class="small ${allSubmitted ? "" : "warn-text"}" style="font-weight:600">${infSubmittedCount} / ${infTotalEmps}</span>
      </div>
      <div class="ts-progress-bar">
        <div class="ts-progress-fill ${allSubmitted ? "submitted" : ""}" style="width:${empPct}%"></div>
      </div>
    </div>
  `;

  if (approvalWorkflow === "manager_then_admin") {
    const deptSubmitted = departments.filter((d) => {
      const members = employees.filter((e) => e.department_id === d.id);
      if (members.length === 0) return false;
      return members.every((e) => {
        const ts = tsMap[e.id];
        return ts && (ts.status === "submitted" || ts.status === "approved");
      });
    });

    const deptTotal = departments.length;
    const deptCount = deptSubmitted.length;
    const deptPct = deptTotal === 0 ? 0 : Math.round((deptCount / deptTotal) * 100);
    const allDepts = deptCount === deptTotal && deptTotal > 0;

    html += `
      <div class="inf-bar-group" style="margin-top:12px">
        <div class="row-flex" style="gap:8px;margin-bottom:4px">
          <span class="small" style="font-weight:600">Departments submitted</span>
          <div class="grow"></div>
          <span class="small ${allDepts ? "" : "warn-text"}" style="font-weight:600">${deptCount} / ${deptTotal}</span>
        </div>
        <div class="ts-progress-bar">
          <div class="ts-progress-fill ${allDepts ? "submitted" : ""}" style="width:${deptPct}%"></div>
        </div>
      </div>
    `;
  }

  barsEl.innerHTML = html;
}

document.getElementById("inf-prev").addEventListener("click", () => {
  infWeek = addDays(infWeek, -7);
  updateInfusionWeekLabel();
  infRows = [];
  loadInfusionStatus();
});
document.getElementById("inf-next").addEventListener("click", () => {
  infWeek = addDays(infWeek, 7);
  updateInfusionWeekLabel();
  infRows = [];
  loadInfusionStatus();
});

updateInfusionWeekLabel();

async function buildInfusionRows() {
  if (!currentOrgId) return [];

  const ws = fmtDate(infWeek);
  const includeDrafts = document.getElementById("inf-include-drafts").checked;

  // Load employees with rates
  const { data: employees } = await sb
    .from("users")
    .select("id, name, employee_code, cost_rate, sell_rate, department_id, active")
    .eq("organisation_id", currentOrgId)
    .eq("active", true)
    .order("name");

  // Load departments for fallback rates
  const { data: departments } = await sb
    .from("departments")
    .select("id, name, cost_rate, sell_rate, is_overhead")
    .eq("organisation_id", currentOrgId);

  // Load timesheets for the week
  let tsQuery = sb
    .from("timesheets")
    .select("id, user_id, status")
    .eq("organisation_id", currentOrgId)
    .eq("week_start", ws);
  if (!includeDrafts) {
    tsQuery = tsQuery.in("status", ["submitted", "approved"]);
  }
  const { data: timesheets } = await tsQuery;

  if (!timesheets?.length) return [];

  const tsIds = timesheets.map((t) => t.id);

  // Load entries with lookups
  const { data: entries } = await sb
    .from("timesheet_entries")
    .select("id, timesheet_id, job_id, task_id, dept_code_id, description, mon_hours, tue_hours, wed_hours, thu_hours, fri_hours, sat_hours, sun_hours")
    .in("timesheet_id", tsIds)
    .order("id");

  // Load jobs, tasks, dept codes for lookup
  const jobIds = [...new Set((entries || []).map((e) => e.job_id).filter(Boolean))];
  const taskIds = [...new Set((entries || []).map((e) => e.task_id).filter(Boolean))];
  const deptCodeIds = [...new Set((entries || []).map((e) => e.dept_code_id).filter(Boolean))];

  let jobMap = {};
  let taskMap = {};
  let deptCodeMap = {};

  if (jobIds.length) {
    const { data } = await sb.from("jobs").select("id, job_code").in("id", jobIds);
    for (const j of data || []) jobMap[j.id] = j.job_code;
  }
  if (taskIds.length) {
    const { data } = await sb.from("tasks").select("id, task_code").in("id", taskIds);
    for (const t of data || []) taskMap[t.id] = t.task_code;
  }
  if (deptCodeIds.length) {
    const { data } = await sb.from("department_codes").select("id, code").in("id", deptCodeIds);
    for (const dc of data || []) deptCodeMap[dc.id] = dc.code;
  }

  const empMap = {};
  for (const e of employees || []) empMap[e.id] = e;
  const deptMap = {};
  for (const d of departments || []) deptMap[d.id] = d;
  const tsUserMap = {};
  for (const t of timesheets) tsUserMap[t.id] = t.user_id;

  function effectiveRate(emp, field) {
    if (emp[field] != null) return Number(emp[field]);
    const dept = emp.department_id ? deptMap[emp.department_id] : null;
    if (dept && !dept.is_overhead && dept[field] != null) return Number(dept[field]);
    return 0;
  }

  // Build rows: for each entry, for each day, one row
  const rows = [];
  for (const entry of entries || []) {
    const userId = tsUserMap[entry.timesheet_id];
    const emp = empMap[userId];
    if (!emp) continue;

    const jobCode = entry.job_id ? (jobMap[entry.job_id] || "") : "";
    const taskCode = entry.task_id ? (taskMap[entry.task_id] || "") : "";
    const deptCode = entry.dept_code_id ? (deptCodeMap[entry.dept_code_id] || "") : "";
    const desc = taskCode
      ? (entry.description ? `${taskCode}-${entry.description}` : taskCode)
      : (entry.description || "");
    const costRate = effectiveRate(emp, "cost_rate");
    const sellRate = effectiveRate(emp, "sell_rate");

    for (let i = 0; i < 7; i++) {
      const dayDate = addDays(infWeek, i);
      const dayKey = DAYS[i];
      const qty = Number(entry[`${dayKey}_hours`]) || 0;

      rows.push({
        "Transaction No": 6,
        "jobid": jobCode,
        "date": fmtDMY(dayDate),
        "employee name": emp.name || "",
        "desc": desc,
        "code": emp.employee_code || "",
        "rate": costRate,
        "qty": qty,
        "sell": sellRate,
        "empty1": "",
        "empty2": "",
        "empty3": "",
        "dept": deptCode,
      });
    }
  }

  rows.sort((a, b) => a["employee name"].localeCompare(b["employee name"]) || a["date"].split("/").reverse().join("").localeCompare(b["date"].split("/").reverse().join("")));
  return rows;
}

// Preview
document.getElementById("inf-preview-btn").addEventListener("click", async () => {
  const preview = document.getElementById("inf-preview");
  const summary = document.getElementById("inf-summary");
  preview.innerHTML = `<p class="muted small" style="text-align:center">Loading…</p>`;

  try {
    infRows = await buildInfusionRows();
    summary.textContent = `${infRows.length} rows`;

    if (!infRows.length) {
      preview.innerHTML = `<p class="muted small" style="text-align:center">No timesheets found for this week.</p>`;
      return;
    }

    const maxPreview = 100;
    const showing = infRows.slice(0, maxPreview);

    preview.innerHTML = `
      <table class="small">
        <thead>
          <tr>
            <th>Trans.</th><th>Job ID</th><th>Date</th><th>Employee</th>
            <th>Description</th><th>Code</th><th>Rate</th><th>Qty</th>
            <th>Sell</th><th colspan="3"></th><th>Dept</th>
          </tr>
        </thead>
        <tbody>
          ${showing.map((r) => `
            <tr>
              <td>${r["Transaction No"]}</td>
              <td>${escapeHtml(r.jobid)}</td>
              <td class="nowrap">${r.date}</td>
              <td>${escapeHtml(r["employee name"])}</td>
              <td>${escapeHtml(r.desc)}</td>
              <td>${escapeHtml(r.code)}</td>
              <td>${r.rate}</td>
              <td>${r.qty}</td>
              <td>${r.sell}</td>
              <td></td><td></td><td></td>
              <td>${escapeHtml(r.dept)}</td>
            </tr>
          `).join("")}
          ${infRows.length > maxPreview ? `<tr><td colspan="13" class="muted small" style="text-align:center">…and ${infRows.length - maxPreview} more rows</td></tr>` : ""}
        </tbody>
      </table>
    `;
  } catch (err) {
    preview.innerHTML = `<p class="muted small" style="text-align:center">Error: ${escapeHtml(err.message)}</p>`;
  }
});

// Export
document.getElementById("inf-export-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("inf-status");

  if (infTotalEmps > 0 && infSubmittedCount < infTotalEmps) {
    const missing = infTotalEmps - infSubmittedCount;
    if (!confirm(`${missing} employee${missing === 1 ? " has" : "s have"} not submitted yet (${infSubmittedCount}/${infTotalEmps}). Export anyway?`)) return;
  }

  statusEl.textContent = "Generating…";

  try {
    if (!infRows.length) {
      infRows = await buildInfusionRows();
    }

    if (!infRows.length) {
      notice("No data to export for this week", "warn");
      statusEl.textContent = "";
      return;
    }

    const headers = [
      "Transaction No", "jobid", "date", "employee name", "desc",
      "code", "rate", "qty", "sell",
      "empty", "empty", "empty", "dept",
    ];

    const wsData = [headers];
    for (const r of infRows) {
      wsData.push([
        r["Transaction No"],
        r.jobid,
        r.date,
        r["employee name"],
        r.desc,
        r.code,
        r.rate,
        r.qty,
        r.sell,
        "", "", "",
        r.dept,
      ]);
    }

    const ws = XLSX.utils.aoa_to_sheet(wsData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Infusion");

    const weekLabel = fmtDate(infWeek);
    XLSX.writeFile(wb, `infusion-export-${weekLabel}.xlsx`);

    statusEl.textContent = "Done";
    notice(`Exported ${infRows.length} rows`, "success");
    setTimeout(() => statusEl.textContent = "", 3000);
  } catch (err) {
    notice(err.message || "Export failed", "error");
    statusEl.textContent = "";
  }
});

/* ================================================================
 * Leave / Overtime Report tab
 * ================================================================ */

let lvWeek = new Date(thisMonday);
let lvRows = [];
let lvSortCol = "employee";
let lvSortAsc = true;

const LV_STANDARD_HOURS = 8;

function updateLvWeekLabel() {
  const end = addDays(lvWeek, 6);
  document.getElementById("lv-week-label").textContent =
    `${lvWeek.toLocaleDateString("en-AU", { month: "short", day: "numeric" })} — ${end.toLocaleDateString("en-AU", { month: "short", day: "numeric", year: "numeric" })}`;
}
updateLvWeekLabel();

document.getElementById("lv-prev").addEventListener("click", () => {
  lvWeek = addDays(lvWeek, -7);
  updateLvWeekLabel();
  loadLeaveReport();
});
document.getElementById("lv-next").addEventListener("click", () => {
  lvWeek = addDays(lvWeek, 7);
  updateLvWeekLabel();
  loadLeaveReport();
});
document.getElementById("lv-include-drafts")?.addEventListener("change", () => loadLeaveReport());

async function buildLeaveRows() {
  if (!currentOrgId) return [];

  const ws = fmtDate(lvWeek);
  const includeDrafts = document.getElementById("lv-include-drafts").checked;

  const { data: employees } = await sb
    .from("users")
    .select("id, name, employee_code, department_id, employment_type, active")
    .eq("organisation_id", currentOrgId)
    .eq("active", true);

  const { data: departments } = await sb
    .from("departments")
    .select("id, name")
    .eq("organisation_id", currentOrgId);

  const { data: allJobs } = await sb
    .from("jobs")
    .select("id, job_code, description, is_leave")
    .eq("organisation_id", currentOrgId);

  const leaveJobIds = new Set((allJobs || []).filter((j) => j.is_leave).map((j) => j.id));
  const jobMap = {};
  for (const j of allJobs || []) jobMap[j.id] = j;

  let tsQuery = sb
    .from("timesheets")
    .select("id, user_id, status")
    .eq("organisation_id", currentOrgId)
    .eq("week_start", ws);
  if (!includeDrafts) {
    tsQuery = tsQuery.in("status", ["submitted", "approved"]);
  }
  const { data: timesheets } = await tsQuery;
  if (!timesheets?.length) return [];

  const tsIds = timesheets.map((t) => t.id);
  const tsUserMap = {};
  for (const t of timesheets) tsUserMap[t.id] = t.user_id;

  const { data: entries } = await sb
    .from("timesheet_entries")
    .select("id, timesheet_id, job_id, description, mon_hours, tue_hours, wed_hours, thu_hours, fri_hours, sat_hours, sun_hours")
    .in("timesheet_id", tsIds);

  if (!entries?.length) return [];

  const empMap = {};
  for (const e of employees || []) empMap[e.id] = e;
  const deptMap = {};
  for (const d of departments || []) deptMap[d.id] = d;

  const rows = [];

  // Leave rows
  for (const entry of entries) {
    if (!leaveJobIds.has(entry.job_id)) continue;
    const userId = tsUserMap[entry.timesheet_id];
    const emp = empMap[userId];
    if (!emp) continue;

    const job = jobMap[entry.job_id];
    const dept = emp.department_id ? deptMap[emp.department_id] : null;
    const totalHours = DAYS.reduce((sum, d) => sum + (Number(entry[`${d}_hours`]) || 0), 0);
    if (totalHours === 0) continue;

    const dailyHours = {};
    for (let i = 0; i < 7; i++) {
      dailyHours[DAY_LABELS[i]] = Number(entry[`${DAYS[i]}_hours`]) || 0;
    }

    rows.push({
      employee: emp.name || "",
      employee_code: emp.employee_code || "",
      department: dept?.name || "",
      employment_type: emp.employment_type || "",
      event: "Leave",
      event_detail: job?.job_code || "",
      event_description: job?.description || "",
      note: entry.description || "",
      ...dailyHours,
      total: totalHours,
    });
  }

  // Overtime rows: per-employee daily totals > standard hours
  const empDayTotals = {};
  for (const entry of entries) {
    const userId = tsUserMap[entry.timesheet_id];
    if (!userId) continue;
    if (!empDayTotals[userId]) empDayTotals[userId] = {};
    for (let i = 0; i < 7; i++) {
      const h = Number(entry[`${DAYS[i]}_hours`]) || 0;
      empDayTotals[userId][i] = (empDayTotals[userId][i] || 0) + h;
    }
  }

  for (const [userId, dayTotals] of Object.entries(empDayTotals)) {
    const emp = empMap[userId];
    if (!emp) continue;
    const dept = emp.department_id ? deptMap[emp.department_id] : null;

    const dailyOT = {};
    let totalOT = 0;
    for (let i = 0; i < 7; i++) {
      const excess = Math.max(0, (dayTotals[i] || 0) - LV_STANDARD_HOURS);
      dailyOT[DAY_LABELS[i]] = excess;
      totalOT += excess;
    }
    if (totalOT === 0) continue;

    rows.push({
      employee: emp.name || "",
      employee_code: emp.employee_code || "",
      department: dept?.name || "",
      employment_type: emp.employment_type || "",
      event: "Overtime",
      event_detail: "OT",
      event_description: `Hours exceeding ${LV_STANDARD_HOURS}h/day`,
      note: "",
      ...dailyOT,
      total: totalOT,
    });
  }

  return rows;
}

function sortLvRows(rows) {
  const col = lvSortCol;
  const dir = lvSortAsc ? 1 : -1;
  return [...rows].sort((a, b) => {
    let cmp = 0;
    const av = a[col], bv = b[col];
    if (typeof av === "number" && typeof bv === "number") {
      cmp = av - bv;
    } else {
      cmp = String(av || "").localeCompare(String(bv || ""));
    }
    if (cmp !== 0) return cmp * dir;
    if (col !== "employee") {
      cmp = (a.employee || "").localeCompare(b.employee || "");
      if (cmp !== 0) return cmp;
    }
    return (a.event_detail || "").localeCompare(b.event_detail || "");
  });
}

function lvSortArrow(col) {
  if (lvSortCol !== col) return "";
  return lvSortAsc ? " &#9650;" : " &#9660;";
}

function renderLvTable() {
  const preview = document.getElementById("lv-preview");
  const sorted = sortLvRows(lvRows);

  const cols = [
    { key: "employee",        label: "Employee" },
    { key: "employee_code",   label: "Code" },
    { key: "department",      label: "Department" },
    { key: "employment_type", label: "Type" },
    { key: "event",           label: "Event" },
    { key: "event_detail",    label: "Detail" },
    { key: "note",            label: "Note" },
  ];

  preview.innerHTML = `
    <table class="small lv-sortable">
      <thead>
        <tr>
          ${cols.map((c) => `<th class="lv-sort-hdr" data-col="${c.key}" style="cursor:pointer;user-select:none">${c.label}${lvSortArrow(c.key)}</th>`).join("")}
          ${DAY_LABELS.map((d) => `<th class="num lv-sort-hdr" data-col="${d}" style="cursor:pointer;user-select:none">${d}${lvSortArrow(d)}</th>`).join("")}
          <th class="num lv-sort-hdr" data-col="total" style="cursor:pointer;user-select:none">Total${lvSortArrow("total")}</th>
        </tr>
      </thead>
      <tbody>
        ${sorted.map((r) => `
          <tr class="${r.event === "Overtime" ? "lv-row-ot" : ""}">
            <td>${escapeHtml(r.employee)}</td>
            <td>${escapeHtml(r.employee_code)}</td>
            <td>${escapeHtml(r.department)}</td>
            <td>${escapeHtml(r.employment_type)}</td>
            <td><strong>${escapeHtml(r.event)}</strong></td>
            <td>${escapeHtml(r.event_detail)}</td>
            <td>${escapeHtml(r.note)}</td>
            ${DAY_LABELS.map((d) => `<td class="num">${r[d] || ""}</td>`).join("")}
            <td class="num"><strong>${r.total}</strong></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  preview.querySelectorAll(".lv-sort-hdr").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.col;
      if (lvSortCol === col) {
        lvSortAsc = !lvSortAsc;
      } else {
        lvSortCol = col;
        lvSortAsc = true;
      }
      renderLvTable();
    });
  });
}

async function loadLeaveReport() {
  const preview = document.getElementById("lv-preview");
  const summary = document.getElementById("lv-summary");
  preview.innerHTML = `<p class="muted small" style="text-align:center">Loading…</p>`;

  try {
    lvRows = await buildLeaveRows();
    const leaveCount = lvRows.filter((r) => r.event === "Leave").length;
    const otCount = lvRows.filter((r) => r.event === "Overtime").length;
    const parts = [];
    if (leaveCount) parts.push(`${leaveCount} leave`);
    if (otCount) parts.push(`${otCount} overtime`);
    summary.textContent = parts.length ? parts.join(", ") : "";

    if (!lvRows.length) {
      preview.innerHTML = `<p class="muted small" style="text-align:center">No leave or overtime entries found for this week.</p>`;
      return;
    }

    renderLvTable();
  } catch (err) {
    preview.innerHTML = `<p class="muted small" style="text-align:center">Error: ${escapeHtml(err.message)}</p>`;
  }
}

// Leave / Overtime export
document.getElementById("lv-export-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("lv-status");
  statusEl.textContent = "Generating…";

  try {
    if (!lvRows.length) lvRows = await buildLeaveRows();

    if (!lvRows.length) {
      notice("No data to export for this week", "warn");
      statusEl.textContent = "";
      return;
    }

    const sorted = sortLvRows(lvRows);

    const headers = [
      "Employee", "Employee Code", "Department", "Employment Type",
      "Event", "Detail", "Description", "Note",
      "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "Total",
    ];

    const wsData = [headers];
    for (const r of sorted) {
      wsData.push([
        r.employee, r.employee_code, r.department, r.employment_type,
        r.event, r.event_detail, r.event_description, r.note,
        r.Mon, r.Tue, r.Wed, r.Thu, r.Fri, r.Sat, r.Sun, r.total,
      ]);
    }

    const ws = XLSX.utils.aoa_to_sheet(wsData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Leave Overtime");

    XLSX.writeFile(wb, `leave-overtime-${fmtDate(lvWeek)}.xlsx`);

    statusEl.textContent = "Done";
    notice(`Exported ${sorted.length} entries`, "success");
    setTimeout(() => statusEl.textContent = "", 3000);
  } catch (err) {
    notice(err.message || "Export failed", "error");
    statusEl.textContent = "";
  }
});

/* ---------------------------------------------------------------- boot */

loadOrgSettings().then(() => loadInfusionStatus());
loadDashboard();
