// PTL Timesheet — My Departments dashboard.
// Managers see departments they manage; admins/developers see all departments.

import { getSupabase } from "/js/supabase-client.js";
import {
  notice, escapeHtml, renderTopbar, getUserContext,
  DAYS, getMonday, getActiveMonday, fmtDate, addDays, fmtHours,
  donutSvg, makeLatestOnly,
  isTsSubmittedOrApproved,
  confirmDialog,
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
      <span class="legend-item"><span class="legend-dot" style="background:#BEFA40"></span> Submitted (${submitted})</span>
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
    if (ts?.status === "exported") {
      badge = "Exported";
      badgeClass = "dept-badge dept-badge-exported";
    } else if (ts?.status === "approved") {
      badge = "Approved";
      badgeClass = "dept-badge dept-badge-approved";
    } else if (sub) {
      badge = "Submitted";
      badgeClass = "dept-badge dept-badge-submitted";
    } else if (ts?.status === "rejected") {
      badge = "Rejected";
      badgeClass = "dept-badge dept-badge-rejected";
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
    } else {
      // Manager can create a draft on behalf of someone in their dept
      // via the same admin-override URL; timesheet.js validates
      // manager-of-target and calls manager_get_or_create_timesheet.
      actions += `<a href="/timesheet.html?user=${e.id}&week=${ws}&admin=1&return=${encodeURIComponent("/department.html")}" class="dept-view-btn">Create</a>`;
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
        <td class="small">${hours ? fmtHours(hours) + "h" : ""}</td>
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
}

await loadOrgSettings();
loadDashboard();
