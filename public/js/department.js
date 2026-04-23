// PTL Timesheet — My Departments dashboard.
// Managers see departments they manage; admins/developers see all departments.

import { getSupabase } from "/js/supabase-client.js";
import { notice, escapeHtml, renderTopbar } from "/js/shared.js";

const sb = await getSupabase();

/* ---------------------------------------------------------------- auth */

const { data: { session } } = await sb.auth.getSession();
if (!session) { location.replace("/signin.html"); throw new Error("not signed in"); }

let employee = null;
let isDeveloper = false;
let adminRow = null;
let isManager = false;
try { const r = await sb.rpc("is_developer"); isDeveloper = !!r.data; } catch {}
try {
  const r = await sb.from("admins").select("organisation_id, role").eq("user_id", session.user.id).maybeSingle();
  adminRow = r.data;
} catch {}
try {
  const r = await sb.from("users").select("id, organisation_id, name, is_manager").eq("auth_user_id", session.user.id).maybeSingle();
  employee = r.data;
  isManager = !!employee?.is_manager;
} catch {}

const isAdminOrDev = isDeveloper || adminRow?.role === "admin";

if (!isManager && !isAdminOrDev) {
  location.replace("/timesheet.html");
  throw new Error("not a manager or admin");
}

const currentOrgId = employee?.organisation_id || adminRow?.organisation_id || null;

renderTopbar({
  session,
  isDeveloper,
  isManager,
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
function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

function renderDonut(container, submitted, total, label) {
  const pct = total === 0 ? 0 : submitted / total;
  const radius = 70;
  const circumference = 2 * Math.PI * radius;
  const filled = circumference * pct;
  const empty = circumference - filled;

  const card = document.createElement("div");
  card.className = "card dash-chart-card";
  card.innerHTML = `
    <h3 style="margin:0 0 12px;text-align:center">${escapeHtml(label)}</h3>
    <div class="donut-wrap">
      <svg viewBox="0 0 200 200" class="donut-svg">
        <circle cx="100" cy="100" r="${radius}" fill="none" stroke="#e8e8e8" stroke-width="18" />
        <circle cx="100" cy="100" r="${radius}" fill="none" stroke="#c2ff00" stroke-width="18"
          stroke-dasharray="${filled} ${empty}"
          stroke-dashoffset="${circumference * 0.25}"
          stroke-linecap="round"
          style="transition: stroke-dasharray 0.6s ease" />
        <text x="100" y="92" text-anchor="middle" class="donut-num">${submitted}/${total}</text>
        <text x="100" y="116" text-anchor="middle" class="donut-pct">${Math.round(pct * 100)}%</text>
      </svg>
    </div>
    <div class="dash-legend">
      <span class="legend-item"><span class="legend-dot" style="background:#c2ff00"></span> Submitted (${submitted})</span>
      <span class="legend-item"><span class="legend-dot" style="background:#e8e8e8;border:1px solid #ccc"></span> Pending (${total - submitted})</span>
    </div>
  `;
  container.appendChild(card);
}

/* ---------------------------------------------------------------- load */

let forceViewBeforeApproval = false;

async function loadOrgSettings() {
  if (!currentOrgId) return;
  const { data } = await sb.from("organisations")
    .select("force_view_before_approval").eq("id", currentOrgId).maybeSingle();
  forceViewBeforeApproval = !!data?.force_view_before_approval;
}

async function loadDashboard() {
  await loadOrgSettings();

  const thisMonday = getMonday(new Date());
  const weekEnd = addDays(thisMonday, 6);
  const weekStr = `${thisMonday.toLocaleDateString(undefined, { day: "numeric", month: "short" })} — ${weekEnd.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
  document.getElementById("mgr-week-label").textContent = `Week of ${weekStr}`;

  const ws = fmtDate(thisMonday);

  // Load all active departments with manager info
  const { data: allDepts } = await sb
    .from("departments")
    .select("id, name, manager_id")
    .eq("organisation_id", currentOrgId)
    .eq("active", true)
    .order("name");

  // Admins/devs see all departments; managers see only their own
  const managedDepts = isAdminOrDev
    ? (allDepts || [])
    : (allDepts || []).filter((d) => d.manager_id === employee?.id);

  if (!managedDepts.length) {
    document.getElementById("page-title").textContent = "My Departments";
    document.getElementById("dept-donuts").innerHTML =
      `<div class="card dash-chart-card"><p class="muted small" style="text-align:center">No departments assigned.</p></div>`;
    document.getElementById("mgr-emp-body").innerHTML =
      `<tr><td colspan="5" class="muted small" style="text-align:center">No employees found.</td></tr>`;
    return;
  }

  const managedDeptIds = new Set(managedDepts.map((d) => d.id));

  // Title
  document.getElementById("page-title").textContent =
    managedDepts.length === 1 ? "My Department" : "My Departments";
  document.getElementById("emp-table-title").textContent =
    managedDepts.length === 1 ? "My Employees" : "Employees";

  // Load all active employees in those departments
  const { data: allEmps } = await sb
    .from("users")
    .select("id, name, department_id, active")
    .eq("organisation_id", currentOrgId)
    .eq("active", true)
    .order("name");

  const myTeam = (allEmps || []).filter((e) => managedDeptIds.has(e.department_id));

  // Load timesheets for current week
  const userIds = myTeam.map((e) => e.id);
  const tsMap = {};
  const hoursMap = {};

  if (userIds.length) {
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
  }

  function isSubmitted(empId) {
    const ts = tsMap[empId];
    return ts && (ts.status === "submitted" || ts.status === "approved");
  }

  // Render donut charts
  const donutsContainer = document.getElementById("dept-donuts");
  donutsContainer.innerHTML = "";

  // Combined "All Departments" donut first (only if multiple departments)
  if (managedDepts.length > 1) {
    const totalAll = myTeam.length;
    const submittedAll = myTeam.filter((e) => isSubmitted(e.id)).length;
    renderDonut(donutsContainer, submittedAll, totalAll, "All Departments");
  }

  // Per-department donuts
  for (const dept of managedDepts) {
    const deptTeam = myTeam.filter((e) => e.department_id === dept.id);
    const submitted = deptTeam.filter((e) => isSubmitted(e.id)).length;
    renderDonut(donutsContainer, submitted, deptTeam.length, dept.name);
  }

  // Render employee table
  const deptNameMap = {};
  for (const d of managedDepts) deptNameMap[d.id] = d.name;

  const body = document.getElementById("mgr-emp-body");
  if (!myTeam.length) {
    body.innerHTML = `<tr><td colspan="5" class="muted small" style="text-align:center">No employees in your departments.</td></tr>`;
    return;
  }

  // Managers must view before approval if setting is on; admins always bypass.
  const canApproveInline = isAdminOrDev || !forceViewBeforeApproval;

  body.innerHTML = myTeam.map((e) => {
    const ts = tsMap[e.id];
    const sub = isSubmitted(e.id);
    const hours = ts ? (hoursMap[ts.id] || 0) : 0;
    const badge = sub
      ? `<span class="chip-dash chip-submitted">Submitted</span>`
      : `<span class="chip-dash chip-pending">Not submitted</span>`;

    let actions = "";
    if (ts) {
      actions += `<a href="/timesheet-view.html?user=${e.id}&week=${ws}" class="btn-link small">View</a>`;
    }
    if (sub && ts.status === "submitted" && canApproveInline) {
      actions += ` <button class="ghost small approve-btn" data-ts-id="${ts.id}">Approve</button>`;
    } else if (sub && ts.status === "submitted" && !canApproveInline) {
      actions += ` <span class="small muted" title="Manager must open the timesheet before approving">Review to approve</span>`;
    } else if (ts?.status === "approved") {
      actions += ` <span class="small muted">Approved</span>`;
    }

    return `
      <tr>
        <td>${escapeHtml(e.name)}</td>
        <td class="muted small">${escapeHtml(deptNameMap[e.department_id] || "")}</td>
        <td>${badge}</td>
        <td class="small">${hours ? hours + "h" : ""}</td>
        <td style="white-space:nowrap">${actions}</td>
      </tr>`;
  }).join("");

  // Approve handlers
  body.querySelectorAll(".approve-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const tsId = Number(btn.dataset.tsId);
      if (!confirm("Approve this timesheet?")) return;
      const { error } = await sb
        .from("timesheets")
        .update({ status: "approved" })
        .eq("id", tsId);
      if (error) return notice(error.message, "error");
      notice("Timesheet approved", "success");
      await loadDashboard();
    });
  });

  // Load pending + approved leave requests for the team
  await Promise.all([
    loadPendingLeaveRequests(myTeam.map((e) => e.id)),
    loadApprovedLeaveRequests(myTeam.map((e) => e.id)),
  ]);
}

let leaveTypesCache = [];
async function ensureLeaveTypes() {
  if (leaveTypesCache.length) return leaveTypesCache;
  const { data } = await sb
    .from("leave_types")
    .select("id, name, sort_order, active")
    .eq("organisation_id", currentOrgId)
    .eq("active", true)
    .order("sort_order");
  leaveTypesCache = data || [];
  return leaveTypesCache;
}

async function loadApprovedLeaveRequests(teamUserIds) {
  const card = document.getElementById("approved-leave-card");
  const body = document.getElementById("approved-leave-body");
  if (!card) return;

  if (!teamUserIds?.length) {
    card.style.display = "none";
    return;
  }

  const todayIso = fmtDate(new Date());
  const { data } = await sb
    .from("leave_requests")
    .select("id, user_id, leave_type_id, start_date, end_date, hours_per_day, skip_weekends, reason, status, users(name), leave_types(name)")
    .eq("organisation_id", currentOrgId)
    .eq("status", "approved")
    .in("user_id", teamUserIds)
    .gte("end_date", todayIso)
    .order("start_date");

  if (!data?.length) {
    card.style.display = "none";
    return;
  }

  card.style.display = "";
  body.innerHTML = data.map((r) => {
    const dateRange = r.start_date === r.end_date
      ? r.start_date
      : `${r.start_date} → ${r.end_date}`;
    return `<tr data-id="${r.id}"
                data-leave-type-id="${r.leave_type_id}"
                data-start="${r.start_date}"
                data-end="${r.end_date}"
                data-hours="${r.hours_per_day}"
                data-skip-weekends="${r.skip_weekends}"
                data-reason="${escapeHtml(r.reason || "")}">
      <td>${escapeHtml(r.users?.name || "")}</td>
      <td>${escapeHtml(r.leave_types?.name || "")}</td>
      <td class="small">${dateRange}</td>
      <td class="num">${r.hours_per_day}</td>
      <td class="small muted">${escapeHtml(r.reason || "")}</td>
      <td style="white-space:nowrap">
        <button class="ghost small edit-lr-btn">Edit</button>
        <button class="ghost small revoke-lr-btn">Revoke</button>
      </td>
    </tr>`;
  }).join("");

  body.querySelectorAll(".edit-lr-btn").forEach((btn) => {
    btn.addEventListener("click", () => openEditLeaveDialog(btn.closest("tr")));
  });

  body.querySelectorAll(".revoke-lr-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.closest("tr").dataset.id);
      if (!confirm("Revoke this leave? The hours will be removed from the timesheet.")) return;
      const note = prompt("Reason for revoking (optional):") || null;
      const { error } = await sb.rpc("revoke_leave_request", { p_request_id: id, p_note: note });
      if (error) return notice(error.message, "error");
      notice("Leave revoked", "success");
      await loadDashboard();
    });
  });
}

async function openEditLeaveDialog(tr) {
  const types = await ensureLeaveTypes();
  const sel = document.getElementById("el-type");
  sel.innerHTML = types.map((t) =>
    `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");
  sel.value = tr.dataset.leaveTypeId;

  document.getElementById("el-start").value = tr.dataset.start;
  document.getElementById("el-end").value = tr.dataset.end;
  document.getElementById("el-hours").value = tr.dataset.hours;
  document.getElementById("el-skip-weekends").checked = tr.dataset.skipWeekends === "true";
  document.getElementById("el-reason").value = tr.dataset.reason || "";

  const form = document.getElementById("edit-leave-form");
  form.dataset.requestId = tr.dataset.id;
  document.getElementById("edit-leave-dialog").showModal();
}

document.getElementById("el-cancel")?.addEventListener("click", () => {
  document.getElementById("edit-leave-dialog").close();
});

document.getElementById("edit-leave-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = Number(e.currentTarget.dataset.requestId);
  const { error } = await sb.rpc("update_approved_leave_request", {
    p_request_id: id,
    p_leave_type_id: Number(document.getElementById("el-type").value),
    p_start_date: document.getElementById("el-start").value,
    p_end_date: document.getElementById("el-end").value,
    p_hours_per_day: Number(document.getElementById("el-hours").value),
    p_skip_weekends: document.getElementById("el-skip-weekends").checked,
    p_reason: document.getElementById("el-reason").value.trim() || null,
  });
  if (error) return notice(error.message, "error");

  document.getElementById("edit-leave-dialog").close();
  notice("Leave updated", "success");
  await loadDashboard();
});

async function loadPendingLeaveRequests(teamUserIds) {
  const card = document.getElementById("leave-requests-card");
  const body = document.getElementById("pending-leave-body");
  if (!card) return;

  if (!teamUserIds?.length) {
    card.style.display = "none";
    return;
  }

  const { data } = await sb
    .from("leave_requests")
    .select("id, user_id, leave_type_id, start_date, end_date, hours_per_day, skip_weekends, reason, status, users(name), leave_types(name)")
    .eq("organisation_id", currentOrgId)
    .eq("status", "pending")
    .in("user_id", teamUserIds)
    .order("created_at");

  if (!data?.length) {
    card.style.display = "none";
    return;
  }

  card.style.display = "";
  body.innerHTML = data.map((r) => {
    const dateRange = r.start_date === r.end_date
      ? r.start_date
      : `${r.start_date} → ${r.end_date}`;
    return `<tr data-id="${r.id}">
      <td>${escapeHtml(r.users?.name || "")}</td>
      <td>${escapeHtml(r.leave_types?.name || "")}</td>
      <td class="small">${dateRange}</td>
      <td class="num">${r.hours_per_day}</td>
      <td class="small muted">${escapeHtml(r.reason || "")}</td>
      <td style="white-space:nowrap">
        <button class="small approve-lr-btn">Approve</button>
        <button class="ghost small reject-lr-btn">Reject</button>
      </td>
    </tr>`;
  }).join("");

  body.querySelectorAll(".approve-lr-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.closest("tr").dataset.id);
      if (!confirm("Approve this leave request? The timesheet will be populated automatically.")) return;
      const { error } = await sb.rpc("approve_leave_request", { p_request_id: id, p_note: null });
      if (error) return notice(error.message, "error");
      notice("Leave approved and timesheet populated", "success");
      await loadDashboard();
    });
  });

  body.querySelectorAll(".reject-lr-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.closest("tr").dataset.id);
      const note = prompt("Reason for rejection (optional):") || null;
      const { error } = await sb.rpc("reject_leave_request", { p_request_id: id, p_note: note });
      if (error) return notice(error.message, "error");
      notice("Leave rejected", "success");
      await loadDashboard();
    });
  });
}

loadDashboard();
