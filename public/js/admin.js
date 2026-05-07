// PTL Timesheet Admin page.
// Tabs: Dashboard (donut charts) | Infusion Export (xlsx generation).

import { getSupabase } from "/js/supabase-client.js";
import {
  notice, escapeHtml, renderTopbar, requireAdmin,
  DAYS, DAY_LABELS, getMonday, fmtDate, addDays, fmtDMY,
  donutSvg, makeLatestOnly,
  TS_STATUS, isTsSubmittedOrApproved,
  confirmDialog,
  fetchWeekDashboardData, invalidateWeekDashboard,
} from "/js/shared.js";

// XLSX is ~600KB. Load only when an Export button is actually clicked.
let _xlsxPromise = null;
function getXLSX() {
  if (!_xlsxPromise) _xlsxPromise = import("https://esm.sh/xlsx@0.18.5");
  return _xlsxPromise;
}

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
    localStorage.setItem("ptl-dev-org-id", String(id));
    if (activeTab === "dashboard") navLoadDashboard();
    if (activeTab === "clockvts") navLoadClockComparison();
    if (activeTab === "infusion") navLoadInfusionStatus();
  },
  active: "admin",
});

if (!currentOrgId) {
  notice("No organisation on this account — contact a developer.", "error", { sticky: true });
}

/* ---------------------------------------------------------------- helpers */

const thisMonday = getMonday(new Date());

/* ---------------------------------------------------------------- tabs */

if (ctx.isDeveloper) {
  const tabBar = document.getElementById("admin-tabs");
  const devBtn = document.createElement("button");
  devBtn.className = "tab";
  devBtn.dataset.tab = "devtools";
  devBtn.textContent = "Dev Tools";
  tabBar.appendChild(devBtn);
}

let activeTab = "dashboard";

document.querySelectorAll("[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-tab]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    activeTab = btn.dataset.tab;
    document.getElementById("tab-dashboard").style.display    = activeTab === "dashboard"   ? "" : "none";
    document.getElementById("tab-clockvts").style.display     = activeTab === "clockvts"    ? "" : "none";
    document.getElementById("tab-infusion").style.display     = activeTab === "infusion"    ? "" : "none";
    document.getElementById("tab-leavereport").style.display  = activeTab === "leavereport" ? "" : "none";
    document.getElementById("tab-devtools").style.display     = activeTab === "devtools"    ? "" : "none";
    if (activeTab === "clockvts") navLoadClockComparison();
    if (activeTab === "infusion") navLoadInfusionStatus();
    if (activeTab === "leavereport") { if (lvSubView === "waged") loadWagedReport(); else loadSalariedReport(); }
    if (activeTab === "devtools") loadDevToolsForm();
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

const navLoadDashboard = makeLatestOnly((signal) => loadDashboard(signal));
document.getElementById("dash-prev").addEventListener("click", () => {
  dashWeek = addDays(dashWeek, -7);
  updateDashWeekLabel();
  navLoadDashboard();
});
document.getElementById("dash-next").addEventListener("click", () => {
  dashWeek = addDays(dashWeek, 7);
  updateDashWeekLabel();
  navLoadDashboard();
});

function renderDonut(containerId, submitted, total, fillColor, emptyColor) {
  const el = document.getElementById(containerId);
  el.innerHTML = donutSvg({ submitted, total, fillColor, emptyColor });
}

async function loadDashboard(signal) {
  if (!currentOrgId) return;

  const ws = fmtDate(dashWeek);
  const dash = await fetchWeekDashboardData(sb, currentOrgId, ws, { signal });
  if (!dash) return;

  const allDepartments = (dash.departments || []).filter((d) => d.active);
  const overheadDeptIds = new Set(allDepartments.filter((d) => d.is_overhead).map((d) => d.id));
  const departments = allDepartments.filter((d) => !d.is_overhead);
  const employees = dash.employees.filter((e) => !overheadDeptIds.has(e.department_id));
  const tsMap = dash.timesheetsByUserId;
  const hoursMap = dash.hoursByTsId;

  const submittedEmps = employees.filter((e) => isTsSubmittedOrApproved(tsMap[e.id]?.status));
  renderDonut("emp-donut", submittedEmps.length, employees.length, "#c2ff00", "#e8e8e8");
  document.getElementById("emp-legend").innerHTML = `
    <span class="legend-item"><span class="legend-dot" style="background:#c2ff00"></span> Submitted (${submittedEmps.length})</span>
    <span class="legend-item"><span class="legend-dot" style="background:#e8e8e8;border:1px solid #ccc"></span> Not submitted (${employees.length - submittedEmps.length})</span>
  `;

  const empsByDept = new Map();
  for (const e of employees) {
    const list = empsByDept.get(e.department_id);
    if (list) list.push(e);
    else empsByDept.set(e.department_id, [e]);
  }
  const deptSubmitted = departments.filter((d) => {
    const members = empsByDept.get(d.id);
    if (!members || !members.length) return false;
    return members.every((e) => isTsSubmittedOrApproved(tsMap[e.id]?.status));
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

  const deptNameById = new Map(departments.map((d) => [d.id, d.name]));
  const deptName = (id) => deptNameById.get(id) || "";

  body.innerHTML = employees.map((e) => {
    const ts = tsMap[e.id];
    const hours = ts ? (hoursMap[ts.id] || 0) : 0;

    let badge, badgeClass;
    if (ts?.status === "approved") {
      badge = "Approved";
      badgeClass = "dept-badge dept-badge-approved";
    } else if (ts?.status === "submitted") {
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

let lastCvtData = null;

async function loadClockComparison(signal) {
  if (!currentOrgId) return;
  const tableEl = document.getElementById("cvt-table");
  const summaryEl = document.getElementById("cvt-summary");
  tableEl.innerHTML = `<p class="muted small" style="text-align:center">Loading…</p>`;
  summaryEl.innerHTML = "";

  // clockTolerance/approvalWorkflow may still be at their defaults if the
  // user hits this tab before module init's loadOrgSettings() resolves.
  await loadOrgSettings();

  const ws = fmtDate(cvtWeek);
  const dash = await fetchWeekDashboardData(sb, currentOrgId, ws, { signal });
  if (!dash) return;

  const allCvtDepts = dash.departments;
  const cvtOverheadIds = new Set(allCvtDepts.filter((d) => d.is_overhead).map((d) => d.id));
  const deptMap = {};
  for (const d of allCvtDepts) if (!d.is_overhead) deptMap[d.id] = d.name;

  const employees = dash.employees.filter((e) => !cvtOverheadIds.has(e.department_id));

  const tsUserMap = {};
  for (const ts of dash.timesheets) tsUserMap[ts.id] = ts.user_id;

  // Sum logged hours per user per day from the shared entries fetch.
  const loggedMap = {};
  for (const e of dash.entries) {
    const uid = tsUserMap[e.timesheet_id];
    if (!uid) continue;
    if (!loggedMap[uid]) loggedMap[uid] = { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 0 };
    for (const d of DAYS) {
      loggedMap[uid][d] += Number(e[`${d}_hours`]) || 0;
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

let orgSettingsPromise = null;
function loadOrgSettings() {
  if (orgSettingsPromise) return orgSettingsPromise;
  orgSettingsPromise = (async () => {
    if (!currentOrgId) return;
    try {
      const { data } = await sb
        .from("organisations")
        .select("approval_workflow, clock_tolerance_hours")
        .eq("id", currentOrgId)
        .maybeSingle();
      approvalWorkflow = data?.approval_workflow || "manager_then_admin";
      if (data?.clock_tolerance_hours != null) clockTolerance = Number(data.clock_tolerance_hours);
    } catch (err) {
      console.warn("approval workflow settings load failed:", err);
      notice("Couldn't load org settings — approval workflow + clock tolerance may be wrong", "warn");
    }
  })();
  return orgSettingsPromise;
}

function updateInfusionWeekLabel() {
  const end = addDays(infWeek, 6);
  document.getElementById("inf-week-label").textContent =
    `${infWeek.toLocaleDateString(undefined, { day: "numeric", month: "short" })} — ${end.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
}

async function loadInfusionStatus(signal) {
  const barsEl = document.getElementById("inf-status-bars");
  if (!currentOrgId) { barsEl.innerHTML = ""; return; }

  // approvalWorkflow drives whether the dept-bar group renders below; awaiting
  // here mirrors loadClockComparison and avoids reading a default mid-init.
  await loadOrgSettings();

  const ws = fmtDate(infWeek);
  const dash = await fetchWeekDashboardData(sb, currentOrgId, ws, { signal });
  if (!dash) { barsEl.innerHTML = ""; return; }

  const allInfDepts = dash.departments.filter((d) => d.active);
  const infOverheadIds = new Set(allInfDepts.filter((d) => d.is_overhead).map((d) => d.id));
  const employees = dash.employees.filter((e) => !infOverheadIds.has(e.department_id));
  const departments = allInfDepts.filter((d) => !d.is_overhead);
  const tsMap = dash.timesheetsByUserId;

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
    const empsByDept = new Map();
    for (const e of employees) {
      const list = empsByDept.get(e.department_id);
      if (list) list.push(e);
      else empsByDept.set(e.department_id, [e]);
    }
    const deptSubmitted = departments.filter((d) => {
      const members = empsByDept.get(d.id);
      if (!members || !members.length) return false;
      return members.every((e) => isTsSubmittedOrApproved(tsMap[e.id]?.status));
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

const navLoadInfusionStatus = makeLatestOnly((signal) => loadInfusionStatus(signal));

document.getElementById("inf-prev").addEventListener("click", () => {
  infWeek = addDays(infWeek, -7);
  updateInfusionWeekLabel();
  infRows = [];
  navLoadInfusionStatus();
});
document.getElementById("inf-next").addEventListener("click", () => {
  infWeek = addDays(infWeek, 7);
  updateInfusionWeekLabel();
  infRows = [];
  navLoadInfusionStatus();
});

updateInfusionWeekLabel();

async function buildInfusionRows() {
  if (!currentOrgId) return [];

  const ws = fmtDate(infWeek);
  const includeDrafts = document.getElementById("inf-include-drafts").checked;

  // Reuse the cached dashboard data for users / departments / timesheets,
  // then fetch only the extra columns (rate fields, employee_code) keyed
  // by id and merge them in. Saves three full org-scoped fetches per
  // export when the user is also viewing the dashboard or infusion-status
  // panel.
  const dash = await fetchWeekDashboardData(sb, currentOrgId, ws);
  if (!dash) return [];

  let timesheets = dash.timesheets;
  if (!includeDrafts) {
    timesheets = timesheets.filter((t) => t.status === "submitted" || t.status === "approved");
  }
  if (!timesheets.length) return [];

  const empIds = dash.employees.map((e) => e.id);
  const deptIds = dash.departments.map((d) => d.id);

  const [empExtraRes, deptExtraRes] = await Promise.all([
    empIds.length
      ? sb.from("users").select("id, employee_code, cost_rate, sell_rate").in("id", empIds)
      : Promise.resolve({ data: [] }),
    deptIds.length
      ? sb.from("departments").select("id, cost_rate, sell_rate").in("id", deptIds)
      : Promise.resolve({ data: [] }),
  ]);

  const empExtraById = new Map((empExtraRes.data || []).map((r) => [r.id, r]));
  const deptExtraById = new Map((deptExtraRes.data || []).map((r) => [r.id, r]));

  const employees = dash.employees.map((e) => ({ ...e, ...(empExtraById.get(e.id) || {}) }));
  const departments = dash.departments.map((d) => ({ ...d, ...(deptExtraById.get(d.id) || {}) }));

  const tsIds = timesheets.map((t) => t.id);

  // Load entries with the related lookup codes inlined via PostgREST joins.
  const { data: entries } = await sb
    .from("timesheet_entries")
    .select("id, timesheet_id, job_id, task_id, dept_code_id, description, mon_hours, tue_hours, wed_hours, thu_hours, fri_hours, sat_hours, sun_hours, jobs(id, job_code), tasks(id, task_code), department_codes(id, code)")
    .in("timesheet_id", tsIds)
    .order("id");

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

    const jobCode = entry.jobs?.job_code || "";
    const taskCode = entry.tasks?.task_code || "";
    const deptCode = entry.department_codes?.code || "";
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
    if (!await confirmDialog({
      title: "Export incomplete week",
      message: `${missing} employee${missing === 1 ? " has" : "s have"} not submitted yet (${infSubmittedCount}/${infTotalEmps}). Export anyway?`,
      confirmText: "Export",
    })) return;
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

    const wsData = [];
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

    const XLSX = await getXLSX();
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

const LV_STANDARD_HOURS = 8;

/* ---------- sub-tab switching ---------- */

let lvSubView = "waged";

document.querySelectorAll("[data-lv-view]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-lv-view]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    lvSubView = btn.dataset.lvView;
    document.getElementById("lv-waged").style.display = lvSubView === "waged" ? "" : "none";
    document.getElementById("lv-salaried").style.display = lvSubView === "salaried" ? "" : "none";
    if (lvSubView === "waged") loadWagedReport();
    if (lvSubView === "salaried") loadSalariedReport();
  });
});

/* ---------- shared: build per-day leave/OT rows for a set of week_starts ---------- */

async function buildLeaveRowsForWeeks(weekStarts, typeFilter, includeDrafts) {
  if (!currentOrgId || !weekStarts.length) return [];

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
    .select("id, user_id, status, week_start")
    .eq("organisation_id", currentOrgId)
    .in("week_start", weekStarts);
  if (!includeDrafts) {
    tsQuery = tsQuery.in("status", ["submitted", "approved"]);
  }
  const { data: timesheets } = await tsQuery;
  if (!timesheets?.length) return [];

  const tsIds = timesheets.map((t) => t.id);
  const tsMap = {};
  for (const t of timesheets) tsMap[t.id] = { user_id: t.user_id, week_start: t.week_start };

  const { data: entries } = await sb
    .from("timesheet_entries")
    .select("id, timesheet_id, job_id, description, mon_hours, tue_hours, wed_hours, thu_hours, fri_hours, sat_hours, sun_hours")
    .in("timesheet_id", tsIds);

  if (!entries?.length) return [];

  const empMap = {};
  for (const e of employees || []) empMap[e.id] = e;
  const deptMap = {};
  for (const d of departments || []) deptMap[d.id] = d;

  // Filter by employment type
  const filteredEmpIds = new Set(
    (employees || []).filter((e) => !typeFilter || e.employment_type === typeFilter).map((e) => e.id)
  );

  const rows = [];

  // Leave rows — one row per day with hours
  for (const entry of entries) {
    if (!leaveJobIds.has(entry.job_id)) continue;
    const ts = tsMap[entry.timesheet_id];
    if (!ts) continue;
    const emp = empMap[ts.user_id];
    if (!emp || !filteredEmpIds.has(emp.id)) continue;

    const job = jobMap[entry.job_id];
    const dept = emp.department_id ? deptMap[emp.department_id] : null;
    const wsDate = new Date(ts.week_start + "T00:00:00");

    for (let i = 0; i < 7; i++) {
      const h = Number(entry[`${DAYS[i]}_hours`]) || 0;
      if (h === 0) continue;
      const dayDate = addDays(wsDate, i);
      rows.push({
        employee: emp.name || "",
        employee_code: emp.employee_code || "",
        department: dept?.name || "",
        employment_type: emp.employment_type || "",
        date: fmtDate(dayDate),
        date_display: dayDate.toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" }),
        event: "Leave",
        event_detail: job?.job_code || "",
        event_description: job?.description || "",
        note: entry.description || "",
        hours: h,
      });
    }
  }

  // Overtime rows — per employee per day
  const empDayTotals = {};
  for (const entry of entries) {
    const ts = tsMap[entry.timesheet_id];
    if (!ts) continue;
    if (!filteredEmpIds.has(ts.user_id)) continue;
    const key = `${ts.user_id}_${ts.week_start}`;
    if (!empDayTotals[key]) empDayTotals[key] = { userId: ts.user_id, wsDate: new Date(ts.week_start + "T00:00:00"), days: {} };
    for (let i = 0; i < 7; i++) {
      const h = Number(entry[`${DAYS[i]}_hours`]) || 0;
      empDayTotals[key].days[i] = (empDayTotals[key].days[i] || 0) + h;
    }
  }

  for (const { userId, wsDate, days } of Object.values(empDayTotals)) {
    const emp = empMap[userId];
    if (!emp) continue;
    const dept = emp.department_id ? deptMap[emp.department_id] : null;
    for (let i = 0; i < 7; i++) {
      const excess = Math.max(0, (days[i] || 0) - LV_STANDARD_HOURS);
      if (excess === 0) continue;
      const dayDate = addDays(wsDate, i);
      rows.push({
        employee: emp.name || "",
        employee_code: emp.employee_code || "",
        department: dept?.name || "",
        employment_type: emp.employment_type || "",
        date: fmtDate(dayDate),
        date_display: dayDate.toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" }),
        event: "Overtime",
        event_detail: "OT",
        event_description: `Hours exceeding ${LV_STANDARD_HOURS}h/day`,
        note: "",
        hours: excess,
      });
    }
  }

  return rows;
}

/* ---------- shared: sort + render ---------- */

let lvSortCol = "employee";
let lvSortAsc = true;

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
    return (a.date || "").localeCompare(b.date || "");
  });
}

function lvSortArrow(col) {
  if (lvSortCol !== col) return "";
  return lvSortAsc ? " &#9650;" : " &#9660;";
}

const LV_COLS = [
  { key: "employee",      label: "Employee" },
  { key: "employee_code", label: "Code" },
  { key: "department",    label: "Department" },
  { key: "date",          label: "Date" },
  { key: "event",         label: "Event" },
  { key: "event_detail",  label: "Detail" },
  { key: "note",          label: "Note" },
  { key: "hours",         label: "Hours" },
];

function renderLvRows(previewId, rows) {
  const preview = document.getElementById(previewId);
  const sorted = sortLvRows(rows);

  preview.innerHTML = `
    <table class="small lv-sortable">
      <thead>
        <tr>
          ${LV_COLS.map((c) => `<th class="${c.key === "hours" ? "num " : ""}lv-sort-hdr" data-col="${c.key}" style="cursor:pointer;user-select:none">${c.label}${lvSortArrow(c.key)}</th>`).join("")}
        </tr>
      </thead>
      <tbody>
        ${sorted.map((r) => `
          <tr class="${r.event === "Overtime" ? "lv-row-ot" : ""}">
            <td>${escapeHtml(r.employee)}</td>
            <td>${escapeHtml(r.employee_code)}</td>
            <td>${escapeHtml(r.department)}</td>
            <td class="nowrap">${escapeHtml(r.date_display)}</td>
            <td><strong>${escapeHtml(r.event)}</strong></td>
            <td>${escapeHtml(r.event_detail)}</td>
            <td>${escapeHtml(r.note)}</td>
            <td class="num"><strong>${r.hours}</strong></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  preview.querySelectorAll(".lv-sort-hdr").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.col;
      if (lvSortCol === col) lvSortAsc = !lvSortAsc;
      else { lvSortCol = col; lvSortAsc = true; }
      renderLvRows(previewId, rows);
    });
  });
}

async function lvExportToExcel(rows, filename) {
  const sorted = sortLvRows(rows);
  const headers = ["Employee", "Employee Code", "Department", "Date", "Event", "Detail", "Description", "Note", "Hours"];
  const wsData = [headers];
  for (const r of sorted) {
    wsData.push([r.employee, r.employee_code, r.department, r.date, r.event, r.event_detail, r.event_description, r.note, r.hours]);
  }
  const XLSX = await getXLSX();
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Leave Overtime");
  XLSX.writeFile(wb, filename);
}

function lvSummaryText(rows) {
  const leaveCount = rows.filter((r) => r.event === "Leave").length;
  const otCount = rows.filter((r) => r.event === "Overtime").length;
  const parts = [];
  if (leaveCount) parts.push(`${leaveCount} leave`);
  if (otCount) parts.push(`${otCount} overtime`);
  return parts.length ? parts.join(", ") : "";
}

/* ---------- Waged (weekly) ---------- */

let lvWeek = new Date(thisMonday);
let lvWagedRows = [];

function updateLvWeekLabel() {
  const end = addDays(lvWeek, 6);
  document.getElementById("lv-week-label").textContent =
    `${lvWeek.toLocaleDateString("en-NZ", { month: "short", day: "numeric" })} — ${end.toLocaleDateString("en-NZ", { month: "short", day: "numeric", year: "numeric" })}`;
}
updateLvWeekLabel();

document.getElementById("lv-prev").addEventListener("click", () => { lvWeek = addDays(lvWeek, -7); updateLvWeekLabel(); loadWagedReport(); });
document.getElementById("lv-next").addEventListener("click", () => { lvWeek = addDays(lvWeek, 7); updateLvWeekLabel(); loadWagedReport(); });
document.getElementById("lv-include-drafts")?.addEventListener("change", () => loadWagedReport());

async function loadWagedReport() {
  const preview = document.getElementById("lv-preview");
  const summary = document.getElementById("lv-summary");
  preview.innerHTML = `<p class="muted small" style="text-align:center">Loading…</p>`;

  try {
    lvWagedRows = await buildLeaveRowsForWeeks([fmtDate(lvWeek)], "waged", document.getElementById("lv-include-drafts").checked);
    summary.textContent = lvSummaryText(lvWagedRows);

    if (!lvWagedRows.length) {
      preview.innerHTML = `<p class="muted small" style="text-align:center">No leave or overtime entries found for waged employees this week.</p>`;
      return;
    }
    renderLvRows("lv-preview", lvWagedRows);
  } catch (err) {
    preview.innerHTML = `<p class="muted small" style="text-align:center">Error: ${escapeHtml(err.message)}</p>`;
  }
}

document.getElementById("lv-export-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("lv-status");
  statusEl.textContent = "Generating…";
  try {
    if (!lvWagedRows.length) lvWagedRows = await buildLeaveRowsForWeeks([fmtDate(lvWeek)], "waged", document.getElementById("lv-include-drafts").checked);
    if (!lvWagedRows.length) { notice("No data to export", "warn"); statusEl.textContent = ""; return; }
    await lvExportToExcel(lvWagedRows, `leave-overtime-waged-${fmtDate(lvWeek)}.xlsx`);
    statusEl.textContent = "Done";
    notice(`Exported ${lvWagedRows.length} entries`, "success");
    setTimeout(() => statusEl.textContent = "", 3000);
  } catch (err) { notice(err.message || "Export failed", "error"); statusEl.textContent = ""; }
});

/* ---------- Salaried (monthly) ---------- */

let lvMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let lvSalariedRows = [];

function updateLvMonthLabel() {
  document.getElementById("lv-month-label").textContent =
    lvMonth.toLocaleDateString("en-NZ", { month: "long", year: "numeric" });
}
updateLvMonthLabel();

document.getElementById("lv-month-prev").addEventListener("click", () => { lvMonth = new Date(lvMonth.getFullYear(), lvMonth.getMonth() - 1, 1); updateLvMonthLabel(); loadSalariedReport(); });
document.getElementById("lv-month-next").addEventListener("click", () => { lvMonth = new Date(lvMonth.getFullYear(), lvMonth.getMonth() + 1, 1); updateLvMonthLabel(); loadSalariedReport(); });
document.getElementById("lv-sal-include-drafts")?.addEventListener("change", () => loadSalariedReport());

function getMondaysInMonth(year, month) {
  const mondays = [];
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  let d = getMonday(first);
  while (d <= last) {
    mondays.push(fmtDate(d));
    d = addDays(d, 7);
  }
  return mondays;
}

async function loadSalariedReport() {
  const preview = document.getElementById("lv-sal-preview");
  const summary = document.getElementById("lv-sal-summary");
  preview.innerHTML = `<p class="muted small" style="text-align:center">Loading…</p>`;

  try {
    const weeks = getMondaysInMonth(lvMonth.getFullYear(), lvMonth.getMonth());
    lvSalariedRows = await buildLeaveRowsForWeeks(weeks, "salaried", document.getElementById("lv-sal-include-drafts").checked);
    summary.textContent = lvSummaryText(lvSalariedRows);

    if (!lvSalariedRows.length) {
      preview.innerHTML = `<p class="muted small" style="text-align:center">No leave or overtime entries found for salaried employees this month.</p>`;
      return;
    }
    renderLvRows("lv-sal-preview", lvSalariedRows);
  } catch (err) {
    preview.innerHTML = `<p class="muted small" style="text-align:center">Error: ${escapeHtml(err.message)}</p>`;
  }
}

document.getElementById("lv-sal-export-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("lv-sal-status");
  statusEl.textContent = "Generating…";
  try {
    if (!lvSalariedRows.length) {
      const weeks = getMondaysInMonth(lvMonth.getFullYear(), lvMonth.getMonth());
      lvSalariedRows = await buildLeaveRowsForWeeks(weeks, "salaried", document.getElementById("lv-sal-include-drafts").checked);
    }
    if (!lvSalariedRows.length) { notice("No data to export", "warn"); statusEl.textContent = ""; return; }
    const monthStr = `${lvMonth.getFullYear()}-${String(lvMonth.getMonth() + 1).padStart(2, "0")}`;
    await lvExportToExcel(lvSalariedRows, `leave-overtime-salaried-${monthStr}.xlsx`);
    statusEl.textContent = "Done";
    notice(`Exported ${lvSalariedRows.length} entries`, "success");
    setTimeout(() => statusEl.textContent = "", 3000);
  } catch (err) { notice(err.message || "Export failed", "error"); statusEl.textContent = ""; }
});

/* ================================================================
 * Dev Tools — Generate Test Timesheets
 * ================================================================ */

let devToolsLoaded = false;

async function loadDevToolsForm() {
  if (devToolsLoaded) return;
  devToolsLoaded = true;

  const { data: depts } = await sb
    .from("departments")
    .select("id, name, is_overhead")
    .eq("organisation_id", currentOrgId)
    .eq("active", true)
    .order("name");

  const sel = document.getElementById("gen-dept");
  sel.innerHTML = (depts || [])
    .filter((d) => !d.is_overhead)
    .map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`)
    .join("");

  const monday = getMonday(new Date());
  document.getElementById("gen-week").value = fmtDate(monday);
}

document.getElementById("gen-timesheets-btn")?.addEventListener("click", async () => {
  const deptId = Number(document.getElementById("gen-dept").value);
  const weekStr = document.getElementById("gen-week").value;
  const targetStatus = document.getElementById("gen-status").value;
  const statusMsg = document.getElementById("gen-status-msg");
  const resultsEl = document.getElementById("gen-results");

  if (!deptId || !weekStr) return notice("Select a department and week", "warn");

  const btn = document.getElementById("gen-timesheets-btn");
  btn.disabled = true;
  statusMsg.textContent = "Loading data…";
  resultsEl.style.display = "none";

  try {
    const [empRes, jobRes, taskRes, dcRes] = await Promise.all([
      sb.from("users").select("id, name").eq("organisation_id", currentOrgId).eq("department_id", deptId).eq("active", true),
      sb.from("jobs").select("id, job_code, status, is_leave, leave_type_id").eq("organisation_id", currentOrgId),
      sb.from("tasks").select("id, task_code").eq("organisation_id", currentOrgId).eq("status", "ACTIVE"),
      sb.from("department_codes").select("id, code").eq("organisation_id", currentOrgId).eq("status", "ACTIVE"),
    ]);

    const employees = empRes.data || [];
    const allJobs = jobRes.data || [];
    const tasks = taskRes.data || [];
    const deptCodes = dcRes.data || [];

    if (!employees.length) {
      statusMsg.textContent = "";
      btn.disabled = false;
      return notice("No active employees in this department", "warn");
    }

    const regularJobs = allJobs.filter((j) => !j.is_leave && j.status === "ACTIVE");
    const nonActiveJobs = allJobs.filter((j) => !j.is_leave && j.status !== "ACTIVE");
    const leaveJobs = allJobs.filter((j) => j.is_leave);

    if (!regularJobs.length) {
      statusMsg.textContent = "";
      btn.disabled = false;
      return notice("No active jobs found — add some jobs first", "warn");
    }

    function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
    function randBetween(min, max) { return Math.round((min + Math.random() * (max - min)) * 4) / 4; }

    const results = [];
    let created = 0;

    for (const emp of employees) {
      statusMsg.textContent = `Generating for ${emp.name}…`;

      // Create or get timesheet
      const { data: tsId, error: tsErr } = await sb.rpc("get_or_create_timesheet", {
        p_week_start: weekStr,
        p_user_id: emp.id,
      });

      let timesheetId = tsId;

      if (tsErr) {
        // RPC may not accept p_user_id — insert directly
        const { data: existing } = await sb
          .from("timesheets")
          .select("id")
          .eq("user_id", emp.id)
          .eq("week_start", weekStr)
          .maybeSingle();

        if (existing) {
          timesheetId = existing.id;
        } else {
          const { data: newTs, error: insErr } = await sb
            .from("timesheets")
            .insert({ organisation_id: currentOrgId, user_id: emp.id, week_start: weekStr, status: "draft" })
            .select("id")
            .single();
          if (insErr) { results.push({ name: emp.name, error: insErr.message }); continue; }
          timesheetId = newTs.id;
        }
      }

      // Clear any existing entries
      await sb.from("timesheet_entries").delete().eq("timesheet_id", timesheetId);

      // Decide how many regular job entries (2-4)
      const numRegular = 2 + Math.floor(Math.random() * 3);
      // Maybe add a leave entry (30% chance)
      const hasLeave = leaveJobs.length > 0 && Math.random() < 0.3;
      // Maybe add overtime on 1-2 days (20% chance)
      const hasOvertime = Math.random() < 0.2;
      // 10% chance of a non-active job
      const hasNonActive = nonActiveJobs.length > 0 && Math.random() < 0.1;

      const entries = [];
      let sortOrder = 0;

      // Regular job entries
      const usedJobs = new Set();
      for (let i = 0; i < numRegular; i++) {
        let job;
        let attempts = 0;
        do { job = pick(regularJobs); attempts++; } while (usedJobs.has(job.id) && attempts < 20);
        usedJobs.add(job.id);

        const hours = { mon_hours: 0, tue_hours: 0, wed_hours: 0, thu_hours: 0, fri_hours: 0, sat_hours: 0, sun_hours: 0 };
        const dayKeys = ["mon_hours", "tue_hours", "wed_hours", "thu_hours", "fri_hours"];

        for (const day of dayKeys) {
          if (Math.random() < 0.7) {
            hours[day] = randBetween(1, 4);
          }
        }

        entries.push({
          timesheet_id: timesheetId,
          job_id: job.id,
          task_id: tasks.length ? pick(tasks).id : null,
          dept_code_id: deptCodes.length ? pick(deptCodes).id : null,
          description: "",
          sort_order: sortOrder++,
          ...hours,
        });
      }

      // Non-active job entry
      if (hasNonActive) {
        const job = pick(nonActiveJobs);
        const hours = { mon_hours: 0, tue_hours: 0, wed_hours: 0, thu_hours: 0, fri_hours: 0, sat_hours: 0, sun_hours: 0 };
        const day = pick(["mon_hours", "tue_hours", "wed_hours", "thu_hours", "fri_hours"]);
        hours[day] = randBetween(1, 3);
        entries.push({
          timesheet_id: timesheetId,
          job_id: job.id,
          task_id: tasks.length ? pick(tasks).id : null,
          dept_code_id: deptCodes.length ? pick(deptCodes).id : null,
          description: "",
          sort_order: sortOrder++,
          ...hours,
        });
      }

      // Leave entry
      if (hasLeave) {
        const leaveJob = pick(leaveJobs);
        const hours = { mon_hours: 0, tue_hours: 0, wed_hours: 0, thu_hours: 0, fri_hours: 0, sat_hours: 0, sun_hours: 0 };
        // 1-2 days of leave
        const leaveDays = 1 + Math.floor(Math.random() * 2);
        const possibleDays = ["mon_hours", "tue_hours", "wed_hours", "thu_hours", "fri_hours"];
        for (let i = 0; i < leaveDays && possibleDays.length; i++) {
          const idx = Math.floor(Math.random() * possibleDays.length);
          hours[possibleDays.splice(idx, 1)[0]] = 8;
        }
        entries.push({
          timesheet_id: timesheetId,
          job_id: leaveJob.id,
          task_id: null,
          dept_code_id: null,
          description: "",
          sort_order: sortOrder++,
          ...hours,
        });
      }

      // Normalize so daily totals are around 8h (with slight variance)
      const dayKeys = ["mon_hours", "tue_hours", "wed_hours", "thu_hours", "fri_hours"];
      for (const day of dayKeys) {
        const total = entries.reduce((s, e) => s + (e[day] || 0), 0);
        let target = randBetween(7.5, 8.5);
        if (hasOvertime && Math.random() < 0.3) target = randBetween(9, 11);
        if (total > 0 && total !== target) {
          const scale = target / total;
          for (const e of entries) {
            e[day] = Math.round((e[day] || 0) * scale * 4) / 4;
          }
        }
      }

      // Insert entries
      const { error: entErr } = await sb.from("timesheet_entries").insert(entries);
      if (entErr) { results.push({ name: emp.name, error: entErr.message }); continue; }

      // Update status
      const update = { status: targetStatus };
      if (targetStatus === "submitted" || targetStatus === "approved") {
        update.submitted_at = new Date().toISOString();
      }
      await sb.from("timesheets").update(update).eq("id", timesheetId);

      const totalHours = entries.reduce((s, e) =>
        s + (e.mon_hours || 0) + (e.tue_hours || 0) + (e.wed_hours || 0) + (e.thu_hours || 0) + (e.fri_hours || 0) + (e.sat_hours || 0) + (e.sun_hours || 0), 0);

      results.push({ name: emp.name, hours: Math.round(totalHours * 10) / 10, entries: entries.length, hasLeave, hasOvertime });
      created++;
    }

    statusMsg.textContent = "";
    resultsEl.style.display = "";
    resultsEl.innerHTML = `
      <p style="color:var(--success);font-weight:600">${created} timesheet${created !== 1 ? "s" : ""} generated</p>
      <table class="small">
        <thead><tr><th>Employee</th><th>Entries</th><th class="num">Hours</th><th>Leave</th><th>OT</th></tr></thead>
        <tbody>
          ${results.map((r) => r.error
            ? `<tr><td>${escapeHtml(r.name)}</td><td colspan="4" style="color:var(--danger)">${escapeHtml(r.error)}</td></tr>`
            : `<tr>
                <td>${escapeHtml(r.name)}</td>
                <td>${r.entries}</td>
                <td class="num">${r.hours}h</td>
                <td>${r.hasLeave ? "✓" : ""}</td>
                <td>${r.hasOvertime ? "✓" : ""}</td>
              </tr>`
          ).join("")}
        </tbody>
      </table>
    `;

    notice(`Generated ${created} timesheets for ${weekStr}`, "success");
  } catch (err) {
    notice(err.message || "Generation failed", "error");
    statusMsg.textContent = "";
  }

  btn.disabled = false;
});

/* ---------------------------------------------------------------- boot */

loadOrgSettings().then(() => navLoadInfusionStatus());
navLoadDashboard();
