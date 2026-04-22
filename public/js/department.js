// PTL Timesheet — My Department dashboard.
// Visible only to managers. Shows a donut chart of team submission rate
// and a list of employees with their status for the current week.

import { getSupabase } from "/js/supabase-client.js";
import { notice, escapeHtml, renderTopbar } from "/js/shared.js";

const sb = await getSupabase();

/* ---------------------------------------------------------------- auth */

const { data: { session } } = await sb.auth.getSession();
if (!session) { location.replace("/signin.html"); throw new Error("not signed in"); }

let employee = null;
let isDeveloper = false;
let adminRow = null;
try { const r = await sb.rpc("is_developer"); isDeveloper = !!r.data; } catch {}
try {
  const r = await sb.from("admins").select("organisation_id, role").eq("user_id", session.user.id).maybeSingle();
  adminRow = r.data;
} catch {}
try {
  const r = await sb.from("users").select("id, organisation_id, name, is_manager").eq("auth_user_id", session.user.id).maybeSingle();
  employee = r.data;
} catch {}

if (!employee?.is_manager && !isDeveloper) {
  location.replace("/timesheet.html");
  throw new Error("not a manager");
}

const currentOrgId = employee?.organisation_id || adminRow?.organisation_id || null;

renderTopbar({
  session,
  isDeveloper,
  isManager: !!employee?.is_manager,
  adminRow,
  orgs: null,
  currentOrgId,
  onOrgChange: () => {},
  active: "department",
});

/* ---------------------------------------------------------------- helpers */

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

function renderDonut(containerId, submitted, total, colorFill, colorEmpty) {
  const el = document.getElementById(containerId);
  if (!el) return;
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

/* ---------------------------------------------------------------- load */

async function loadDashboard() {
  const thisMonday = getMonday(new Date());
  const weekEnd = addDays(thisMonday, 6);
  const weekStr = `${thisMonday.toLocaleDateString(undefined, { day: "numeric", month: "short" })} — ${weekEnd.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
  document.getElementById("mgr-week-label").textContent = `Week of ${weekStr}`;

  const ws = fmtDate(thisMonday);

  // Load departments managed by this user
  const { data: departments } = await sb
    .from("departments")
    .select("id, name, active")
    .eq("organisation_id", currentOrgId)
    .eq("active", true)
    .order("name");

  const myDepts = (departments || []).filter((d) => d.manager_id === employee.id);
  const myDeptIds = new Set(myDepts.map((d) => d.id));

  // Need manager_id — re-fetch with it
  const { data: deptsWithMgr } = await sb
    .from("departments")
    .select("id, name, manager_id")
    .eq("organisation_id", currentOrgId)
    .eq("active", true);

  const managedDepts = (deptsWithMgr || []).filter((d) => d.manager_id === employee.id);
  const managedDeptIds = new Set(managedDepts.map((d) => d.id));

  // Load employees in those departments
  const { data: allEmps } = await sb
    .from("users")
    .select("id, name, department_id, active")
    .eq("organisation_id", currentOrgId)
    .eq("active", true)
    .order("name");

  const myTeam = (allEmps || []).filter((e) => managedDeptIds.has(e.department_id));

  if (!myTeam.length) {
    document.getElementById("mgr-emp-body").innerHTML =
      `<tr><td colspan="4" class="muted small" style="text-align:center">No employees in your departments.</td></tr>`;
    renderDonut("mgr-donut", 0, 0, "#c2ff00", "#e8e8e8");
    document.getElementById("mgr-legend").innerHTML = `<span class="muted small">No team members found</span>`;
    return;
  }

  // Load timesheets for current week
  const userIds = myTeam.map((e) => e.id);
  let tsMap = {};
  let hoursMap = {};

  const { data: tsList } = await sb
    .from("timesheets")
    .select("id, user_id, status")
    .eq("organisation_id", currentOrgId)
    .eq("week_start", ws)
    .in("user_id", userIds);

  for (const ts of tsList || []) tsMap[ts.user_id] = ts;

  const tsIds = (tsList || []).map((t) => t.id);
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

  const submittedCount = myTeam.filter((e) => {
    const ts = tsMap[e.id];
    return ts && (ts.status === "submitted" || ts.status === "approved");
  }).length;

  renderDonut("mgr-donut", submittedCount, myTeam.length, "#c2ff00", "#e8e8e8");
  document.getElementById("mgr-legend").innerHTML = `
    <span class="legend-item"><span class="legend-dot" style="background:#c2ff00"></span> Submitted (${submittedCount})</span>
    <span class="legend-item"><span class="legend-dot" style="background:#e8e8e8;border:1px solid #ccc"></span> Not submitted (${myTeam.length - submittedCount})</span>
  `;

  const deptName = (id) => managedDepts.find((d) => d.id === id)?.name || "";

  const body = document.getElementById("mgr-emp-body");
  body.innerHTML = myTeam.map((e) => {
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
