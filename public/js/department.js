// PTL Timesheet — My Departments dashboard.
// Managers see departments they manage; admins/developers see all departments.

import { getSupabase } from "/js/supabase-client.js";
import {
  notice, escapeHtml, renderTopbar, getUserContext,
  DAYS, getMonday, getActiveMonday, fmtDate, addDays,
  donutSvg, makeLatestOnly,
  isTsSubmittedOrApproved,
  confirmDialog, promptDialog,
  fetchWeekDashboardData, invalidateWeekDashboard,
  isUserEffectiveOverhead,
} from "/js/shared.js";

const sb = await getSupabase();

/* ---------------------------------------------------------------- auth */

const { data: { session } } = await sb.auth.getSession();
if (!session) { location.replace("/signin.html"); throw new Error("not signed in"); }

const ctx = await getUserContext(sb, session);
const { isDeveloper, adminRow, isManager, isClockViewer, employee } = ctx;

const isAdminOrDev = isDeveloper || adminRow?.role === "admin";
// Leave RPCs (approve_leave_request, reject_leave_request,
// update_approved_leave_request, revoke_leave_request) are gated on
// is_manager_of() in SQL, which only matches admins.role in
// ('admin','manager','developer'). A users.is_manager-only "department lead"
// can see the dashboard but their RPC calls are rejected. Hide the action
// buttons from them so they don't get the "Not authorised" error.
const canActOnLeave = isAdminOrDev || adminRow?.role === "manager";

if (!isManager && !isAdminOrDev) {
  location.replace("/timesheet.html");
  throw new Error("not a manager or admin");
}

const currentOrgId = employee?.organisation_id || adminRow?.organisation_id || null;

renderTopbar({
  sb,
  session,
  isDeveloper,
  isManager,
  isClockViewer,
  adminRow,
  orgs: null,
  currentOrgId,
  onOrgChange: () => {},
  active: "department",
});

/* ---------------------------------------------------------------- helpers */

function renderDonut(container, submitted, total, label) {
  const card = document.createElement("div");
  card.className = "card dash-chart-card";
  card.innerHTML = `
    <h3 style="margin:0 0 12px;text-align:center">${escapeHtml(label)}</h3>
    <div class="donut-wrap">${donutSvg({ submitted, total })}</div>
    <div class="dash-legend">
      <span class="legend-item"><span class="legend-dot" style="background:#c2ff00"></span> Submitted (${submitted})</span>
      <span class="legend-item"><span class="legend-dot" style="background:#e8e8e8;border:1px solid #ccc"></span> Pending (${total - submitted})</span>
    </div>
  `;
  container.appendChild(card);
}

/* ---------------------------------------------------------------- week nav */

let deptWeek = getActiveMonday();

function updateDeptWeekLabel() {
  const end = addDays(deptWeek, 6);
  document.getElementById("mgr-week-label").textContent =
    `${deptWeek.toLocaleDateString(undefined, { day: "numeric", month: "short" })} — ${end.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
}
updateDeptWeekLabel();

const navLoadDashboard = makeLatestOnly((signal) => loadDashboard(signal));
document.getElementById("dept-prev").addEventListener("click", () => {
  deptWeek = addDays(deptWeek, -7);
  updateDeptWeekLabel();
  navLoadDashboard();
});
document.getElementById("dept-next").addEventListener("click", () => {
  deptWeek = addDays(deptWeek, 7);
  updateDeptWeekLabel();
  navLoadDashboard();
});

/* ---------------------------------------------------------------- load */

let forceViewBeforeApproval = false;

let approvalWorkflow = "manager_then_admin";
async function loadOrgSettings() {
  if (!currentOrgId) return;
  const { data } = await sb.from("organisations")
    .select("force_view_before_approval, approval_workflow").eq("id", currentOrgId).maybeSingle();
  forceViewBeforeApproval = !!data?.force_view_before_approval;
  approvalWorkflow = data?.approval_workflow || "manager_then_admin";
}

async function loadDashboard(signal) {

  const ws = fmtDate(deptWeek);
  const dash = await fetchWeekDashboardData(sb, currentOrgId, ws);
  if (!dash) return;

  const allDepts = dash.departments.filter((d) => d.active);
  // Per-user effective-overhead lets a manager in an overhead dept who
  // has their own rate still count toward the manager dashboard. A dept
  // surfaces only if it still has a non-overhead member after filtering.
  const deptById = new Map(allDepts.map((d) => [d.id, d]));
  const billingEmployees = dash.employees.filter((e) =>
    !isUserEffectiveOverhead(e, deptById.get(e.department_id)));
  const remainingDeptIds = new Set(billingEmployees.map((e) => e.department_id));
  const nonOverheadDepts = allDepts.filter((d) => remainingDeptIds.has(d.id));

  // Admins/devs see all non-overhead departments; managers see only their own
  const managedDepts = isAdminOrDev
    ? nonOverheadDepts
    : nonOverheadDepts.filter((d) => d.manager_id === employee?.id);

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

  const myTeam = billingEmployees.filter((e) => managedDeptIds.has(e.department_id));

  // tsMap is a real Map so number keys stay numbers (Object.entries
  // stringifies, which silently mismatches when callers look up by e.id).
  const teamIds = new Set(myTeam.map((e) => e.id));
  const tsMap = new Map();
  for (const [uid, ts] of Object.entries(dash.timesheetsByUserId)) {
    const numId = Number(uid);
    if (teamIds.has(numId)) tsMap.set(numId, ts);
  }
  const hoursMap = dash.hoursByTsId;

  function isSubmitted(empId) {
    const ts = tsMap.get(empId);
    return isTsSubmittedOrApproved(ts?.status);
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
  // direct_to_admin mode: managers don't get approve buttons at all
  // (admins/devs always do, regardless of mode).
  const managersCanApprove = isAdminOrDev || approvalWorkflow !== "direct_to_admin";
  const canApproveInline = managersCanApprove && (isAdminOrDev || !forceViewBeforeApproval);

  body.innerHTML = myTeam.map((e) => {
    const ts = tsMap.get(e.id);
    const sub = isSubmitted(e.id);
    const hours = ts ? (hoursMap[ts.id] || 0) : 0;

    let badge, badgeClass;
    if (ts?.status === "approved") {
      badge = "Approved";
      badgeClass = "dept-badge dept-badge-approved";
    } else if (sub) {
      badge = "Submitted";
      badgeClass = "dept-badge dept-badge-submitted";
    } else if (ts?.status === "draft") {
      badge = "Draft";
      badgeClass = "dept-badge dept-badge-draft";
    } else {
      badge = "Not submitted";
      badgeClass = "dept-badge dept-badge-none";
    }

    let actions = "";
    if (ts) {
      actions += `<a href="/timesheet-view.html?user=${e.id}&week=${ws}" class="dept-view-btn">View</a>`;
    }
    if (sub && ts.status === "submitted" && canApproveInline) {
      actions += `<button class="dept-approve-btn approve-btn" data-ts-id="${ts.id}">Approve</button>`;
      actions += `<button class="dept-approve-btn reject-btn ghost" data-ts-id="${ts.id}">Reject</button>`;
    } else if (sub && ts.status === "submitted" && !canApproveInline) {
      actions += `<span class="small muted" title="Manager must open the timesheet before approving or rejecting">Review to decide</span>`;
    }

    return `
      <tr>
        <td>${escapeHtml(e.name)}</td>
        <td class="muted small">${escapeHtml(deptNameMap[e.department_id] || "")}</td>
        <td><span class="${badgeClass}">${badge}</span></td>
        <td class="small">${hours ? hours + "h" : ""}</td>
        <td style="white-space:nowrap">${actions}</td>
      </tr>`;
  }).join("");

  // Approve / reject handlers. Both use the same shape: update only when
  // the row is still 'submitted' so a concurrent decision doesn't get
  // silently clobbered.
  const decide = async (tsId, newStatus) => {
    const verb = newStatus === "approved" ? "Approve" : "Reject";
    if (!await confirmDialog({
      title: `${verb} timesheet`,
      message: `${verb} this timesheet?`,
      confirmText: verb,
    })) return;
    const { data: rows, error } = await sb
      .from("timesheets")
      .update({ status: newStatus })
      .eq("id", tsId)
      .eq("status", "submitted")
      .select("id");
    if (error) return notice(error.message, "error");
    if (!rows?.length) {
      notice("Already actioned by another manager", "warn");
    } else {
      notice(`Timesheet ${newStatus === "approved" ? "approved" : "rejected"}`, "success");
    }
    invalidateWeekDashboard(currentOrgId, fmtDate(deptWeek));
    await loadDashboard();
  };

  body.querySelectorAll(".approve-btn").forEach((btn) => {
    btn.addEventListener("click", () => decide(Number(btn.dataset.tsId), "approved"));
  });
  body.querySelectorAll(".reject-btn").forEach((btn) => {
    btn.addEventListener("click", () => decide(Number(btn.dataset.tsId), "rejected"));
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
        ${canActOnLeave ? `
          <button class="ghost small edit-lr-btn">Edit</button>
          <button class="ghost small revoke-lr-btn">Revoke</button>
        ` : ""}
      </td>
    </tr>`;
  }).join("");

  body.querySelectorAll(".edit-lr-btn").forEach((btn) => {
    btn.addEventListener("click", () => openEditLeaveDialog(btn.closest("tr")));
  });

  body.querySelectorAll(".revoke-lr-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.closest("tr").dataset.id);
      if (!await confirmDialog({ title: "Revoke leave", message: "Revoke this leave? The hours will be removed from the timesheet.", confirmText: "Revoke", danger: true })) return;
      const note = await promptDialog({ title: "Revoke leave", message: "Reason for revoking (optional):" }) || null;
      const { error } = await sb.rpc("revoke_leave_request", { p_request_id: id, p_note: note });
      if (error) return notice(error.message, "error");
      notice("Leave revoked", "success");
      // Leave can span multiple weeks; wipe every week for the org so we
      // don't render stale cached data on weeks the cursor isn't currently
      // viewing.
      invalidateWeekDashboard(currentOrgId);
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
  invalidateWeekDashboard(currentOrgId);
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
        ${canActOnLeave ? `
          <button class="small approve-lr-btn">Approve</button>
          <button class="ghost small reject-lr-btn">Reject</button>
        ` : `<span class="small muted">Awaiting manager</span>`}
      </td>
    </tr>`;
  }).join("");

  body.querySelectorAll(".approve-lr-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.closest("tr").dataset.id);
      if (!await confirmDialog({ title: "Approve leave", message: "Approve this leave request? The timesheet will be populated automatically.", confirmText: "Approve" })) return;
      const { error } = await sb.rpc("approve_leave_request", { p_request_id: id, p_note: null });
      if (error) return notice(error.message, "error");
      notice("Leave approved and timesheet populated", "success");
      invalidateWeekDashboard(currentOrgId);
      await loadDashboard();
    });
  });

  body.querySelectorAll(".reject-lr-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.closest("tr").dataset.id);
      const note = await promptDialog({ title: "Reject leave", message: "Reason for rejection (optional):" }) || null;
      const { error } = await sb.rpc("reject_leave_request", { p_request_id: id, p_note: note });
      if (error) return notice(error.message, "error");
      notice("Leave rejected", "success");
      invalidateWeekDashboard(currentOrgId);
      await loadDashboard();
    });
  });
}

await loadOrgSettings();
loadDashboard();
