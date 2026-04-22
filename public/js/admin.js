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
function fmtDate(d) { return d.toISOString().slice(0, 10); }
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
    document.getElementById("tab-dashboard").style.display = activeTab === "dashboard" ? "" : "none";
    document.getElementById("tab-infusion").style.display  = activeTab === "infusion"  ? "" : "none";
    if (activeTab === "infusion") updateInfusionWeekLabel();
  });
});

/* ================================================================
 * Dashboard tab
 * ================================================================ */

const weekEnd = addDays(thisMonday, 6);
const weekStr = `${thisMonday.toLocaleDateString(undefined, { day: "numeric", month: "short" })} — ${weekEnd.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
document.getElementById("week-label").textContent = `Week of ${weekStr}`;

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

  const ws = fmtDate(thisMonday);

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
  renderDonut("emp-donut", submittedEmps.length, employees.length, "#2e7d3a", "#e8e8e8");
  document.getElementById("emp-legend").innerHTML = `
    <span class="legend-item"><span class="legend-dot" style="background:#2e7d3a"></span> Submitted (${submittedEmps.length})</span>
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
    const submitted = ts && (ts.status === "submitted" || ts.status === "approved");
    const hours = ts ? (hoursMap[ts.id] || 0) : 0;
    const badge = submitted
      ? `<span class="chip-dash chip-submitted">Submitted</span>`
      : `<span class="chip-dash chip-pending">Not submitted</span>`;
    return `
      <tr>
        <td>${escapeHtml(e.name)}</td>
        <td class="muted small">${escapeHtml(deptName(e.department_id))}</td>
        <td>${badge}</td>
        <td class="small">${hours ? hours + "h" : ""}</td>
      </tr>`;
  }).join("");
}

/* ================================================================
 * Infusion Export tab
 * ================================================================ */

let infWeek = new Date(thisMonday);
let infRows = [];

function updateInfusionWeekLabel() {
  const end = addDays(infWeek, 6);
  document.getElementById("inf-week-label").textContent =
    `${infWeek.toLocaleDateString(undefined, { day: "numeric", month: "short" })} — ${end.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
}

document.getElementById("inf-prev").addEventListener("click", () => {
  infWeek = addDays(infWeek, -7);
  updateInfusionWeekLabel();
});
document.getElementById("inf-next").addEventListener("click", () => {
  infWeek = addDays(infWeek, 7);
  updateInfusionWeekLabel();
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
        "empty4": "",
        "dept": deptCode,
      });
    }
  }

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
            <th>Sell</th><th colspan="4"></th><th>Dept</th>
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
              <td></td><td></td><td></td><td></td>
              <td>${escapeHtml(r.dept)}</td>
            </tr>
          `).join("")}
          ${infRows.length > maxPreview ? `<tr><td colspan="14" class="muted small" style="text-align:center">…and ${infRows.length - maxPreview} more rows</td></tr>` : ""}
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
      "empty", "empty", "empty", "empty", "dept",
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
        "", "", "", "",
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

/* ---------------------------------------------------------------- boot */

loadDashboard();
