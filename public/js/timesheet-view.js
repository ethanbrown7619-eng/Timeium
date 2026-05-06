// PTL Timesheet — Read-only viewer for managers/admins with approve/reject.
// URL params: ?user=<user_id>&week=<YYYY-MM-DD>

import { getSupabase } from "/js/supabase-client.js";
import {
  notice, escapeHtml, renderTopbar, getUserContext,
  DAYS, addDays, fmtShortDate,
  confirmDialog, promptDialog,
} from "/js/shared.js";

const sb = await getSupabase();

/* ---------------------------------------------------------------- auth */

const { data: { session } } = await sb.auth.getSession();
if (!session) { location.replace("/signin.html"); throw new Error("not signed in"); }

const ctx = await getUserContext(sb, session);
const { isDeveloper, adminRow, isManager, employee: me } = ctx;

const isAdminOrDev = isDeveloper || adminRow?.role === "admin";
if (!isManager && !isAdminOrDev) {
  location.replace("/timesheet.html");
  throw new Error("not authorised");
}

const currentOrgId = me?.organisation_id || adminRow?.organisation_id || null;

renderTopbar({
  sb, session, isDeveloper, isManager, adminRow,
  orgs: null, currentOrgId, onOrgChange: () => {},
  active: "department",
});

/* ---------------------------------------------------------------- params */

const params = new URLSearchParams(location.search);
const viewUserId = Number(params.get("user"));
const weekStart = params.get("week");

if (!viewUserId || !weekStart) {
  notice("Missing user or week parameter", "error", { sticky: true });
  throw new Error("missing params");
}

/* ---------------------------------------------------------------- load */

async function load() {
  // Load employee
  const { data: emp } = await sb.from("users")
    .select("id, name, email, department_id").eq("id", viewUserId).maybeSingle();
  if (!emp) { notice("Employee not found", "error"); return; }

  document.getElementById("view-title").textContent = `${emp.name}'s Timesheet`;

  // Load timesheet for this user+week
  const { data: ts } = await sb.from("timesheets")
    .select("id, status, submitted_at, notes")
    .eq("user_id", viewUserId).eq("week_start", weekStart).maybeSingle();

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
    jobIds.length ? sb.from("jobs").select("id, job_code, status").in("id", jobIds) : Promise.resolve({ data: [] }),
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
  for (const d of DAYS) {
    const dayTotal = (entries || []).reduce((s, e) => s + Number(e[`${d}_hours`] || 0), 0);
    document.getElementById(`total-${d}`).textContent = dayTotal || "";
    weekTotal += dayTotal;
  }
  document.getElementById("total-week").innerHTML = `<strong>${weekTotal}</strong>`;

  // Show approve/reject only for submitted timesheets
  const bar = document.getElementById("approve-bar");
  if (ts.status === "submitted") {
    bar.style.display = "";
    document.getElementById("approve-btn").onclick = async () => {
      if (!await confirmDialog({ title: "Approve timesheet", message: "Approve this timesheet?", confirmText: "Approve" })) return;
      const { error } = await sb.from("timesheets").update({ status: "approved" }).eq("id", ts.id);
      if (error) return notice(error.message, "error");
      notice("Timesheet approved", "success");
      setTimeout(() => location.href = "/department.html", 600);
    };
    document.getElementById("reject-btn").onclick = async () => {
      const note = await promptDialog({ title: "Reject timesheet", message: "Reason for rejection (optional):", placeholder: "e.g. Missing job code on Wednesday" }) || null;
      if (!await confirmDialog({ title: "Reject timesheet", message: "Reject this timesheet? The employee will need to resubmit.", confirmText: "Reject", danger: true })) return;
      const { error } = await sb.from("timesheets").update({ status: "rejected", notes: note }).eq("id", ts.id);
      if (error) return notice(error.message, "error");
      notice("Timesheet rejected", "success");
      setTimeout(() => location.href = "/department.html", 600);
    };
  } else if (ts.status === "approved") {
    document.getElementById("ts-view-status").textContent = "Already approved";
  }
}

load();
