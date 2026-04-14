// Manager approval page.
// Shows three lists for the selected week:
//   1. Submissions waiting for approval (submitted)
//   2. Employees who haven't submitted yet (missing_submissions RPC)
//   3. Recently approved / paid submissions
//
// Clicking "Review" opens a dialog with the full timesheet grid (read-only
// view via load_timesheet_week) and approve / reject buttons.

import {
  requireAuth,
  renderTopbar,
  mondayOf,
  isoDate,
  weekDays,
  formatShortDate,
  formatLongDate,
  notice,
  escapeHtml,
} from "/js/shared.js";

const ctx = await requireAuth({ requireManager: true });
renderTopbar(ctx, "manager");
const sb = ctx.supabase;

let selectedMonday = mondayOf(new Date());
document.getElementById("week-picker").value = isoDate(selectedMonday);
document.getElementById("week-picker").addEventListener("change", (e) => {
  selectedMonday = mondayOf(new Date(e.target.value));
  document.getElementById("week-picker").value = isoDate(selectedMonday);
  loadAll();
});

document.getElementById("send-reminders").addEventListener("click", sendReminders);

await loadAll();

/* -------------------------------------------------------------- load */

async function loadAll() {
  await Promise.all([loadPending(), loadMissing(), loadApproved()]);
}

async function loadPending() {
  const week = isoDate(selectedMonday);
  const { data, error } = await sb
    .from("timesheet_submissions")
    .select(
      "id, user_id, total_hours, regular_hours, overtime_hours, submitted_at, status, users:user_id(name, department)"
    )
    .eq("week_start", week)
    .eq("status", "submitted")
    .order("submitted_at", { ascending: true });

  const body = document.getElementById("pending-body");
  if (error) return (body.innerHTML = errRow(8, error.message));
  if (!data || data.length === 0)
    return (body.innerHTML = emptyRow(8, "No submissions awaiting approval for this week."));

  // Fetch clock totals for the same week for a quick at-a-glance column.
  const { data: clockTotals } = await sb.rpc("weekly_timesheet", {
    week_start: week,
    tz: null,
  });
  const clockMap = new Map();
  for (const r of clockTotals || []) {
    clockMap.set(r.user_id, (clockMap.get(r.user_id) || 0) + Number(r.hours || 0));
  }

  body.innerHTML = data
    .map((s) => {
      const clockHrs = clockMap.get(s.user_id) || 0;
      const discrepant = Math.abs(Number(s.total_hours) - clockHrs) > 0.25 && clockHrs > 0;
      return `
        <tr>
          <td>${escapeHtml(s.users?.name || `#${s.user_id}`)}</td>
          <td class="muted">${escapeHtml(s.users?.department || "")}</td>
          <td class="num">${Number(s.regular_hours).toFixed(2)}</td>
          <td class="num">${Number(s.overtime_hours).toFixed(2)}</td>
          <td class="num"><strong>${Number(s.total_hours).toFixed(2)}</strong></td>
          <td class="num ${discrepant ? "discrepancy" : ""}">${clockHrs.toFixed(2)}</td>
          <td class="small muted">${s.submitted_at ? new Date(s.submitted_at).toLocaleString() : "—"}</td>
          <td><button data-review="${s.id}">Review</button></td>
        </tr>`;
    })
    .join("");

  body.querySelectorAll("[data-review]").forEach((btn) =>
    btn.addEventListener("click", () => openDetail(Number(btn.dataset.review)))
  );
}

async function loadMissing() {
  const week = isoDate(selectedMonday);
  const { data, error } = await sb.rpc("missing_submissions", { p_week_start: week });
  const body = document.getElementById("missing-body");
  if (error) return (body.innerHTML = errRow(5, error.message));
  if (!data || data.length === 0)
    return (body.innerHTML = emptyRow(5, "Everyone has at least a draft for this week. 🎯"));

  body.innerHTML = data
    .map(
      (r) => `
        <tr>
          <td>${escapeHtml(r.name)}</td>
          <td class="muted">${escapeHtml(r.department || "")}</td>
          <td class="muted small">${escapeHtml(r.email || "")}</td>
          <td><span class="chip ${r.status}">${r.status}</span></td>
          <td><button class="ghost" data-remind="${r.user_id}">Remind</button></td>
        </tr>`
    )
    .join("");

  body.querySelectorAll("[data-remind]").forEach((btn) =>
    btn.addEventListener("click", () => remindOne(Number(btn.dataset.remind)))
  );
}

async function loadApproved() {
  const week = isoDate(selectedMonday);
  const { data, error } = await sb
    .from("timesheet_submissions")
    .select("id, user_id, total_hours, status, approved_at, users:user_id(name)")
    .eq("week_start", week)
    .in("status", ["manager_approved", "paid", "rejected"])
    .order("approved_at", { ascending: false });

  const body = document.getElementById("approved-body");
  if (error) return (body.innerHTML = errRow(5, error.message));
  if (!data || data.length === 0)
    return (body.innerHTML = emptyRow(5, "Nothing approved yet for this week."));

  body.innerHTML = data
    .map(
      (s) => `
      <tr>
        <td>${escapeHtml(s.users?.name || `#${s.user_id}`)}</td>
        <td class="num">${Number(s.total_hours).toFixed(2)}</td>
        <td><span class="chip ${s.status}">${s.status.replace("_", " ")}</span></td>
        <td class="small muted">${s.approved_at ? new Date(s.approved_at).toLocaleString() : "—"}</td>
        <td><button class="ghost" data-review="${s.id}">View</button></td>
      </tr>`
    )
    .join("");

  body.querySelectorAll("[data-review]").forEach((btn) =>
    btn.addEventListener("click", () => openDetail(Number(btn.dataset.review)))
  );
}

/* -------------------------------------------------------------- detail */

async function openDetail(submissionId) {
  const { data: subs } = await sb
    .from("timesheet_submissions")
    .select("*, users:user_id(id, name, department, email, employee_code)")
    .eq("id", submissionId)
    .maybeSingle();
  if (!subs) return notice("Submission not found", "error");

  const { data: detail, error } = await sb.rpc("load_timesheet_week", {
    p_week_start: subs.week_start,
    p_user_id: subs.user_id,
  });
  if (error) return notice(error.message, "error");

  const dialog = document.getElementById("detail-dialog");
  const body = document.getElementById("detail-body");

  body.innerHTML = renderDetailHtml(subs, detail);
  dialog.showModal();

  document.getElementById("close-detail")?.addEventListener("click", () => dialog.close());
  document.getElementById("approve-btn")?.addEventListener("click", async () => {
    const noteVal = document.getElementById("manager-note")?.value || null;
    const { error } = await sb.rpc("approve_timesheet", {
      p_submission_id: submissionId,
      p_manager_note: noteVal,
    });
    if (error) return notice(error.message, "error");
    notice("Timesheet approved", "success");
    dialog.close();
    loadAll();
  });
  document.getElementById("reject-btn")?.addEventListener("click", async () => {
    const reason = prompt("Reason for rejection (shown to the employee):");
    if (!reason) return;
    const { error } = await sb.rpc("reject_timesheet", {
      p_submission_id: submissionId,
      p_reason: reason,
    });
    if (error) return notice(error.message, "error");
    notice("Timesheet rejected", "success");
    dialog.close();
    loadAll();
  });
  document.getElementById("pay-btn")?.addEventListener("click", async () => {
    const { error } = await sb.rpc("mark_timesheet_paid", { p_submission_id: submissionId });
    if (error) return notice(error.message, "error");
    notice("Marked as paid", "success");
    dialog.close();
    loadAll();
  });
}

function renderDetailHtml(sub, detail) {
  const days = weekDays(sub.week_start);
  const dayKeys = days.map(isoDate);
  const entries = detail.entries || [];
  const clock = Object.fromEntries((detail.clock_hours || []).map((c) => [c.day, Number(c.hours) || 0]));

  // Group into project+task rows.
  const byKey = new Map();
  for (const e of entries) {
    const key = `${e.project_id}::${e.task_id}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        job: `${e.job_number} · ${e.project_number}`,
        task: e.task_name,
        hours: [0, 0, 0, 0, 0, 0, 0],
        note: e.note,
      });
    }
    const row = byKey.get(key);
    const idx = dayKeys.indexOf(e.work_date);
    if (idx >= 0) row.hours[idx] = Number(e.hours) || 0;
  }

  const rowsHtml = [...byKey.values()]
    .map(
      (r) => `
      <tr>
        <td>${escapeHtml(r.job)}</td>
        <td>${escapeHtml(r.task)}</td>
        ${r.hours
          .map((h) => `<td class="num">${h > 0 ? h.toFixed(2) : ""}</td>`)
          .join("")}
        <td class="num"><strong>${r.hours.reduce((a, b) => a + b, 0).toFixed(2)}</strong></td>
      </tr>`
    )
    .join("");

  const dailyTotals = [0, 0, 0, 0, 0, 0, 0];
  for (const row of byKey.values())
    for (let d = 0; d < 7; d++) dailyTotals[d] += row.hours[d] || 0;

  const clockCells = dayKeys
    .map((k, d) => {
      const hrs = clock[k] || 0;
      const disc = Math.abs(dailyTotals[d] - hrs) > 0.25 && hrs > 0;
      return `<td class="num small ${disc ? "discrepancy" : "muted"}">${hrs ? hrs.toFixed(2) : "—"}</td>`;
    })
    .join("");

  const isPending = sub.status === "submitted";
  const isApproved = sub.status === "manager_approved";

  return `
    <div class="row-flex mb-md">
      <div>
        <h2 style="margin:0">${escapeHtml(sub.users.name)} · ${formatLongDate(sub.week_start)}</h2>
        <div class="muted small">
          ${escapeHtml(sub.users.department || "")} ·
          ${escapeHtml(sub.users.email || "")} ·
          Status: <span class="chip ${sub.status}">${sub.status.replace("_", " ")}</span>
        </div>
      </div>
      <div class="grow"></div>
      <button class="ghost" id="close-detail">Close</button>
    </div>

    <table>
      <thead>
        <tr>
          <th>Job · Project</th>
          <th>Task</th>
          ${days.map((d) => `<th class="num small">${formatShortDate(d)}</th>`).join("")}
          <th class="num">Total</th>
        </tr>
      </thead>
      <tbody>${rowsHtml || `<tr><td colspan="10" class="muted small">No entries.</td></tr>`}</tbody>
      <tfoot>
        <tr>
          <td colspan="2" class="text-right">Daily</td>
          ${dailyTotals.map((d) => `<td class="num">${d.toFixed(2)}</td>`).join("")}
          <td class="num"><strong>${Number(sub.total_hours).toFixed(2)}</strong></td>
        </tr>
        <tr>
          <td colspan="2" class="text-right muted small">Clock hours</td>
          ${clockCells}
          <td class="num muted small">—</td>
        </tr>
      </tfoot>
    </table>

    ${
      sub.employee_note
        ? `<div class="mt-md"><strong>Employee note:</strong><div class="muted">${escapeHtml(sub.employee_note)}</div></div>`
        : ""
    }

    <div class="mt-md">
      <label for="manager-note">Manager note (optional)</label>
      <textarea id="manager-note" rows="2" style="width:100%">${escapeHtml(sub.manager_note || "")}</textarea>
    </div>

    <div class="mt-md row-flex">
      ${isPending ? `<button id="approve-btn">Approve</button>` : ""}
      ${isPending || isApproved ? `<button id="reject-btn" class="danger">Reject</button>` : ""}
      ${isApproved && ctx.roles.isAdmin ? `<button id="pay-btn" class="ghost">Mark paid</button>` : ""}
    </div>
  `;
}

/* -------------------------------------------------------------- reminders */

async function remindOne(userId) {
  const { error } = await sb.from("pending_notifications").insert({
    user_id: userId,
    kind: "timesheet_reminder",
    payload: { week_start: isoDate(selectedMonday) },
  });
  if (error) return notice(error.message, "error");
  notice("Reminder queued", "success");
}

async function sendReminders() {
  const week = isoDate(selectedMonday);
  const { data, error } = await sb.rpc("missing_submissions", { p_week_start: week });
  if (error) return notice(error.message, "error");
  if (!data || data.length === 0) return notice("No one to remind", "info");

  const { error: insErr } = await sb.from("pending_notifications").insert(
    data.map((u) => ({
      user_id: u.user_id,
      kind: "timesheet_reminder",
      payload: { week_start: week },
    }))
  );
  if (insErr) return notice(insErr.message, "error");
  document.getElementById("reminder-status").textContent =
    `Queued ${data.length} reminder(s) at ${new Date().toLocaleTimeString()}`;
  notice(`Queued ${data.length} reminders`, "success");
}

/* -------------------------------------------------------------- ui helpers */

function errRow(cols, msg) {
  return `<tr><td colspan="${cols}" class="notice error">${escapeHtml(msg)}</td></tr>`;
}
function emptyRow(cols, msg) {
  return `<tr><td colspan="${cols}" class="muted small" style="text-align:center;padding:16px">${escapeHtml(msg)}</td></tr>`;
}
