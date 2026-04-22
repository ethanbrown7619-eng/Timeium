// PTL Timesheet Admin Dashboard.
// Two donut charts: departments submitted, employees submitted.
// Below: full employee list with submission status for the current week.

import { getSupabase } from "/js/supabase-client.js";
import { notice, escapeHtml, renderTopbar, requireAdmin } from "/js/shared.js";

const sb = await getSupabase();
const ctx = await requireAdmin(sb);
let currentOrgId = ctx.currentOrgId;

renderTopbar({
  session: ctx.session,
  isDeveloper: ctx.isDeveloper,
  adminRow: ctx.adminRow,
  orgs: ctx.orgs,
  currentOrgId,
  onOrgChange: (id) => {
    currentOrgId = id;
    localStorage.setItem("temporium-dev-org-id", String(id));
    loadDashboard();
  },
  active: "admin",
});

if (!currentOrgId) {
  notice("No organisation on this account — contact a developer.", "error", { sticky: true });
}

const DAYS = ["mon","tue","wed","thu","fri","sat","sun"];

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

const thisMonday = getMonday(new Date());
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

  // Load hours for submitted timesheets
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

  // Employee donut
  const submittedEmps = employees.filter((e) => {
    const ts = tsMap[e.id];
    return ts && (ts.status === "submitted" || ts.status === "approved");
  });
  renderDonut("emp-donut", submittedEmps.length, employees.length, "#2e7d3a", "#e8e8e8");
  document.getElementById("emp-legend").innerHTML = `
    <span class="legend-item"><span class="legend-dot" style="background:#2e7d3a"></span> Submitted (${submittedEmps.length})</span>
    <span class="legend-item"><span class="legend-dot" style="background:#e8e8e8;border:1px solid #ccc"></span> Not submitted (${employees.length - submittedEmps.length})</span>
  `;

  // Department donut — a dept is "submitted" when ALL its active employees have submitted
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

  // Employee table
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

loadDashboard();
