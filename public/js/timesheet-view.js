// PTL Timesheet — Read-only viewer for managers/admins with approve/reject.
// URL params: ?user=<user_id>&week=<YYYY-MM-DD>

import { getSupabase } from "/js/supabase-client.js";
import {
  notice, escapeHtml, renderTopbar, getUserContext,
  DAYS, addDays, fmtShortDate, fmtHours, computeOvertime,
  confirmDialog, promptDialog,
  invalidateWeekDashboard,
} from "/js/shared.js";

const sb = await getSupabase();

/* ---------------------------------------------------------------- auth */

const { data: { session } } = await sb.auth.getSession();
if (!session) { location.replace("/signin.html"); throw new Error("not signed in"); }

const ctx = await getUserContext(sb, session);
const { isDeveloper, adminRow, isManager, isClockViewer, employee: me } = ctx;

const isAdminOrDev = isDeveloper || adminRow?.role === "admin";
if (!isManager && !isAdminOrDev) {
  location.replace("/timesheet.html");
  throw new Error("not authorised");
}

const currentOrgId = me?.organisation_id || adminRow?.organisation_id || null;

renderTopbar({
  sb, session, isDeveloper, isManager, isClockViewer, adminRow,
  orgs: null, currentOrgId, onOrgChange: () => {},
  active: "department",
});

/* ---------------------------------------------------------------- params */

const params = new URLSearchParams(location.search);
const viewUserId = Number(params.get("user"));
const weekStart = params.get("week");
const returnTo = params.get("return") === "admin" ? "/admin.html#tab=infusion" : "/department.html";

if (!viewUserId || !weekStart) {
  notice("Missing user or week parameter", "error", { sticky: true });
  throw new Error("missing params");
}

document.getElementById("back-link").href = returnTo;
if (returnTo.startsWith("/admin.html")) {
  document.getElementById("back-link").textContent = "← Back to Admin";
}

/* ---------------------------------------------------------------- load */

async function load() {
  // Load employee (incl. OT flags so we can render the overtime row).
  const { data: emp } = await sb.from("users")
    .select("id, name, email, department_id, receives_overtime, overtime_daily_threshold_hours")
    .eq("id", viewUserId).maybeSingle();
  if (!emp) { notice("Employee not found", "error"); return; }

  document.getElementById("view-title").textContent = `${emp.name}'s Timesheet`;

  // Load timesheet for this user+week
  const { data: ts } = await sb.from("timesheets")
    .select("id, status, submitted_at, notes")
    .eq("user_id", viewUserId).eq("week_start", weekStart).maybeSingle();

  // Admins always see Edit. Managers see Edit if they manage the target
  // user. Check via the user_manages_target_user RPC (security definer)
  // rather than hand-rolling the dept lookup client-side.
  let canEdit = isAdminOrDev;
  if (!canEdit && isManager) {
    const { data: managesTarget } = await sb.rpc("user_manages_target_user", { p_user_id: viewUserId });
    canEdit = managesTarget === true;
  }
  if (canEdit) {
    const editBtn = document.getElementById("admin-edit-btn");
    editBtn.classList.remove("hidden");
    editBtn.textContent = "Edit";
    editBtn.onclick = () => {
      const ret = encodeURIComponent(returnTo);
      location.href = `/timesheet.html?user=${viewUserId}&week=${weekStart}&admin=1&return=${ret}`;
    };
  }

  if (!ts) {
    document.getElementById("view-subtitle").textContent = `Week of ${weekStart} — no timesheet created`;
    document.getElementById("view-body").innerHTML =
      `<tr><td colspan="13" class="muted small" style="text-align:center;padding:24px">No timesheet for this week.</td></tr>`;
    return;
  }

  const weekStartDate = new Date(weekStart + "T00:00:00");
  const weekEndDate = addDays(weekStartDate, 6);
  document.getElementById("view-subtitle").textContent =
    `${weekStartDate.toLocaleDateString("en-AU", { day: "numeric", month: "short" })} — ${weekEndDate.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })} · Status: ${ts.status}`;

  // Date row
  document.getElementById("date-row").innerHTML = `<td colspan="5"></td>` +
    DAYS.map((_, i) => {
      const d = addDays(weekStartDate, i);
      const isWeekend = i >= 5;
      return `<td class="day-col${isWeekend ? " day-weekend" : ""}">${fmtShortDate(d)}</td>`;
    }).join("") + `<td class="day-col"></td>`;

  // Load entries with lookups
  const { data: entries } = await sb.from("timesheet_entries")
    .select("id, job_id, task_id, dept_code_id, description, mon_hours, tue_hours, wed_hours, thu_hours, fri_hours, sat_hours, sun_hours")
    .eq("timesheet_id", ts.id);

  const jobIds = [...new Set((entries || []).map((e) => e.job_id).filter(Boolean))];
  const taskIds = [...new Set((entries || []).map((e) => e.task_id).filter(Boolean))];
  const deptIds = [...new Set((entries || []).map((e) => e.dept_code_id).filter(Boolean))];

  const [jobs, tasks, deptCodes] = await Promise.all([
    jobIds.length ? sb.from("jobs").select("id, job_code, status, is_leave").in("id", jobIds) : Promise.resolve({ data: [] }),
    taskIds.length ? sb.from("tasks").select("id, task_code").in("id", taskIds) : Promise.resolve({ data: [] }),
    deptIds.length ? sb.from("department_codes").select("id, code").in("id", deptIds) : Promise.resolve({ data: [] }),
  ]);

  const jobMap = Object.fromEntries((jobs.data || []).map((j) => [j.id, j]));
  const taskMap = Object.fromEntries((tasks.data || []).map((t) => [t.id, t]));
  const deptMap = Object.fromEntries((deptCodes.data || []).map((d) => [d.id, d]));

  const body = document.getElementById("view-body");
  if (!entries?.length) {
    body.innerHTML = `<tr><td colspan="13" class="muted small" style="text-align:center;padding:24px">No tasks on this timesheet.</td></tr>`;
  } else {
    body.innerHTML = entries.map((e) => {
      const job = jobMap[e.job_id];
      const task = taskMap[e.task_id];
      const dept = deptMap[e.dept_code_id];
      const rowTotal = DAYS.reduce((s, d) => s + Number(e[`${d}_hours`] || 0), 0);
      return `<tr>
        <td>${escapeHtml(job?.job_code || "")}</td>
        <td><span class="small status-badge status-${(job?.status || "").toLowerCase()}">${escapeHtml(job?.status || "")}</span></td>
        <td>${escapeHtml(dept?.code || "")}</td>
        <td>${escapeHtml(task?.task_code || "")}</td>
        <td class="small">${escapeHtml(e.description || "")}</td>
        ${DAYS.map((d, i) => `
          <td class="day-col${i >= 5 ? " day-weekend" : ""}">${Number(e[`${d}_hours`]) || ""}</td>
        `).join("")}
        <td class="day-col"><strong>${rowTotal || ""}</strong></td>
      </tr>`;
    }).join("");
  }

  // Totals footer
  let weekTotal = 0;
  const workedByDay = [0, 0, 0, 0, 0, 0, 0]; // non-leave only, for OT calc
  for (let i = 0; i < DAYS.length; i++) {
    const d = DAYS[i];
    let dayTotal = 0;
    let workedTotal = 0;
    for (const e of entries || []) {
      const h = Number(e[`${d}_hours`] || 0);
      dayTotal += h;
      const job = jobMap[e.job_id];
      if (!job?.is_leave) workedTotal += h;
    }
    document.getElementById(`total-${d}`).textContent = dayTotal ? fmtHours(dayTotal) : "";
    weekTotal += dayTotal;
    workedByDay[i] = workedTotal;
  }
  document.getElementById("total-week").innerHTML = `<strong>${fmtHours(weekTotal)}</strong>`;

  // Overtime row — only for employees flagged receives_overtime. Computed
  // from worked (non-leave) hours: weekend = all OT, weekday = anything
  // above daily threshold (default 8).
  if (emp.receives_overtime) {
    const threshold = Number(emp.overtime_daily_threshold_hours) || 8;
    const { otByDay, otTotal } = computeOvertime(workedByDay, threshold);
    document.getElementById("overtime-row").style.display = "";
    for (let i = 0; i < DAYS.length; i++) {
      document.getElementById(`ot-${DAYS[i]}`).textContent =
        otByDay[i] ? fmtHours(otByDay[i]) : "";
    }
    document.getElementById("ot-week").innerHTML =
      `<strong>${otTotal ? fmtHours(otTotal) : "0"}</strong>`;
  }

  // Show approve/reject only for submitted timesheets, and only to users
  // who actually have authority under the org's approval_workflow setting.
  // direct_to_admin -> managers don't see the buttons.
  const { data: orgRow } = await sb.from("organisations")
    .select("approval_workflow").eq("id", currentOrgId).maybeSingle();
  const approvalWorkflow = orgRow?.approval_workflow || "manager_then_admin";
  const canDecide = isAdminOrDev || approvalWorkflow !== "direct_to_admin";

  const bar = document.getElementById("approve-bar");
  if (ts.status === "submitted" && canDecide) {
    bar.style.display = "";
    document.getElementById("approve-btn").onclick = async () => {
      if (!await confirmDialog({ title: "Approve timesheet", message: "Approve this timesheet?", confirmText: "Approve" })) return;
      const { data: rows, error } = await sb.from("timesheets")
        .update({ status: "approved" })
        .eq("id", ts.id)
        .eq("status", "submitted")
        .select("id");
      if (error) return notice(error.message, "error");
      if (!rows?.length) {
        notice("Already actioned by another manager", "warn");
        setTimeout(() => location.href = returnTo, 600);
        return;
      }
      invalidateWeekDashboard(currentOrgId, weekStart);
      notice("Timesheet approved", "success");
      setTimeout(() => location.href = returnTo, 600);
    };
    document.getElementById("reject-btn").onclick = async () => {
      const note = await promptDialog({ title: "Reject timesheet", message: "Reason for rejection (optional):", placeholder: "e.g. Missing job code on Wednesday" }) || null;
      if (!await confirmDialog({ title: "Reject timesheet", message: "Reject this timesheet? The employee will need to resubmit.", confirmText: "Reject", danger: true })) return;
      const { data: rows, error } = await sb.from("timesheets")
        .update({ status: "rejected", notes: note })
        .eq("id", ts.id)
        .eq("status", "submitted")
        .select("id");
      if (error) return notice(error.message, "error");
      if (!rows?.length) {
        notice("Already actioned by another manager", "warn");
        setTimeout(() => location.href = returnTo, 600);
        return;
      }
      invalidateWeekDashboard(currentOrgId, weekStart);
      notice("Timesheet rejected", "success");
      setTimeout(() => location.href = returnTo, 600);
    };
  } else if (ts.status === "approved") {
    document.getElementById("ts-view-status").textContent = "Already approved";
  }

  // Submit-on-behalf escape hatch: admins always, managers if they
  // manage the target user. Same gate as the Edit button — canEdit was
  // computed earlier. Goes through the SECURITY DEFINER RPC which
  // accepts either role (migration 119).
  if ((ts.status === "draft" || ts.status === "rejected") && canEdit) {
    const submitBar = document.getElementById("admin-submit-bar");
    submitBar.style.display = "";
    const isRejected = ts.status === "rejected";
    document.getElementById("admin-submit-btn").textContent =
      isRejected ? "Resubmit on behalf" : "Submit on behalf";
    document.getElementById("admin-submit-btn").onclick = async () => {
      // Department is required on every hour-bearing, non-leave row —
      // same rule the employee's own submit enforces, and the DB
      // trigger (migration 148) backstops. Checking here first gives
      // the manager a readable message instead of an RPC error.
      const missingDept = (entries || []).filter((e) => {
        if (jobMap[e.job_id]?.is_leave) return false;
        const hasHours = DAYS.some((d) => Number(e[`${d}_hours`]) > 0);
        return hasHours && !e.dept_code_id;
      }).length;
      if (missingDept) {
        notice(
          `Cannot submit: ${missingDept} row(s) have hours but no department selected. ` +
          `Use Edit to fill in the department column first.`,
          "warn",
        );
        return;
      }
      const ok = await confirmDialog({
        title: isRejected ? "Resubmit on behalf" : "Submit on behalf",
        message: isRejected
          ? "Resubmit this rejected timesheet for the employee? It will move back to 'submitted' for re-review."
          : "Submit this draft timesheet for the employee? It will move to 'submitted' as if they had clicked Submit themselves.",
        confirmText: isRejected ? "Resubmit on behalf" : "Submit on behalf",
      });
      if (!ok) return;
      const { error } = await sb.rpc("admin_submit_timesheet", { p_timesheet_id: ts.id });
      if (error) return notice(error.message, "error");
      invalidateWeekDashboard(currentOrgId, weekStart);
      notice(isRejected ? "Timesheet resubmitted" : "Timesheet submitted", "success");
      setTimeout(() => location.href = returnTo, 600);
    };
  }
}

load();
