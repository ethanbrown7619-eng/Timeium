// PTL Timesheet — employee leave request page.
//
// Phase B of the leave workflow: shows the signed-in user's own leave
// history and lets them submit new requests via the submit_leave_request
// RPC. Status follows the two-step state machine from migration 126;
// cancellation is restricted to pre-approval statuses.

import { getSupabase } from "/js/supabase-client.js";
import {
  notice, escapeHtml, renderTopbar, getUserContext,
  fmtDate, fmtHours, confirmDialog,
} from "/js/shared.js";

const sb = await getSupabase();

const { data: { session } } = await sb.auth.getSession();
if (!session) { location.replace("/signin.html"); throw new Error("not signed in"); }

const ctx = await getUserContext(sb, session);
const { isDeveloper, adminRow, isManager, isClockViewer, employee } = ctx;

if (!employee) {
  location.replace("/welcome.html");
  throw new Error("no employee record");
}

const currentOrgId = employee.organisation_id;

renderTopbar({
  sb, session, isDeveloper, isManager, isClockViewer, adminRow,
  orgs: null, currentOrgId, onOrgChange: () => {},
  active: "leave",
});

// ---------------------------------------------------------------- data

let leaveTypes = [];

async function loadLeaveTypes() {
  const { data, error } = await sb.from("leave_types")
    .select("id, code, name, unit")
    .eq("organisation_id", currentOrgId)
    .eq("active", true)
    .order("sort_order");
  if (error) {
    notice(`Could not load leave types: ${error.message}`, "error");
    return;
  }
  leaveTypes = data || [];
  const sel = document.getElementById("req-type");
  sel.innerHTML = leaveTypes.map((t) =>
    `<option value="${t.id}">${escapeHtml(t.name)}</option>`
  ).join("");
}

function statusBadge(status) {
  switch (status) {
    case "pending_manager": return `<span class="dept-badge dept-badge-draft">Pending manager</span>`;
    case "pending_admin":   return `<span class="dept-badge dept-badge-submitted">Pending admin</span>`;
    case "approved":        return `<span class="dept-badge dept-badge-approved">Approved</span>`;
    case "rejected":        return `<span class="dept-badge dept-badge-rejected">Rejected</span>`;
    case "cancelled":       return `<span class="dept-badge dept-badge-none">Cancelled</span>`;
    default:                return `<span class="dept-badge dept-badge-none">${escapeHtml(status || "")}</span>`;
  }
}

async function loadRequests() {
  const body = document.getElementById("leave-list-body");
  const { data, error } = await sb.from("leave_requests")
    .select("id, leave_type_id, start_date, end_date, hours_per_day, skip_weekends, reason, status, manager_review_note, review_note, created_at, leave_types ( name )")
    .eq("user_id", employee.id)
    .order("created_at", { ascending: false });
  if (error) {
    body.innerHTML = `<tr><td colspan="8" class="muted small" style="text-align:center;color:#c00">${escapeHtml(error.message)}</td></tr>`;
    return;
  }
  const rows = data || [];
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="8" class="muted small" style="text-align:center;padding:24px">No leave requests yet. Click "Request leave" to submit one.</td></tr>`;
    return;
  }

  body.innerHTML = rows.map((r) => {
    const typeName = r.leave_types?.name || "—";
    const canCancel = r.status === "pending_manager" || r.status === "pending_admin";
    const noteParts = [];
    if (r.reason)              noteParts.push(escapeHtml(r.reason));
    if (r.manager_review_note) noteParts.push(`<em class="muted small">Manager: ${escapeHtml(r.manager_review_note)}</em>`);
    if (r.review_note)         noteParts.push(`<em class="muted small">Admin: ${escapeHtml(r.review_note)}</em>`);
    const reasonCell = noteParts.length ? noteParts.join("<br>") : `<span class="muted small">—</span>`;

    return `<tr>
      <td>${escapeHtml(typeName)}</td>
      <td class="small">${escapeHtml(r.start_date || "")}</td>
      <td class="small">${escapeHtml(r.end_date || "")}</td>
      <td class="num small">${fmtHours(r.hours_per_day)}</td>
      <td>${statusBadge(r.status)}</td>
      <td class="small">${reasonCell}</td>
      <td class="small muted">${r.created_at ? new Date(r.created_at).toLocaleString() : ""}</td>
      <td class="small">${canCancel ? `<button class="ghost small cancel-btn" data-id="${r.id}">Cancel</button>` : ""}</td>
    </tr>`;
  }).join("");

  for (const btn of document.querySelectorAll(".cancel-btn")) {
    btn.addEventListener("click", () => cancelRequest(Number(btn.dataset.id)));
  }
}

async function cancelRequest(id) {
  const ok = await confirmDialog({
    title: "Cancel leave request",
    message: "Withdraw this leave request? It can't be un-cancelled — you'd need to submit a new one.",
    confirmText: "Cancel request",
    danger: true,
  });
  if (!ok) return;
  const { error } = await sb.rpc("cancel_leave_request", { p_request_id: id });
  if (error) return notice(error.message, "error");
  notice("Leave request cancelled", "success");
  await loadRequests();
}

// ---------------------------------------------------------------- modal

const dialog = document.getElementById("request-dialog");
const form = document.getElementById("request-form");

document.getElementById("open-request-btn").addEventListener("click", () => {
  // Reset to a sensible default each open: today as start, +1 day as end.
  const today = new Date();
  const tmrw = new Date(today.getTime() + 86400000);
  document.getElementById("req-start").value = fmtDate(today);
  document.getElementById("req-end").value = fmtDate(tmrw);
  document.getElementById("req-hours").value = 8;
  document.getElementById("req-skip-weekends").checked = true;
  document.getElementById("req-reason").value = "";
  dialog.showModal();
});

document.getElementById("req-cancel-btn").addEventListener("click", () => dialog.close());

form.addEventListener("submit", async (e) => {
  // Default form submit on the dialog calls dialog.close() because
  // method="dialog"; we want to call the RPC first.
  e.preventDefault();

  const typeId = Number(document.getElementById("req-type").value);
  const startDate = document.getElementById("req-start").value;
  const endDate = document.getElementById("req-end").value;
  const hoursPerDay = Number(document.getElementById("req-hours").value);
  const skipWeekends = document.getElementById("req-skip-weekends").checked;
  const reason = document.getElementById("req-reason").value.trim() || null;

  if (!typeId) return notice("Pick a leave type", "warn");
  if (!startDate || !endDate) return notice("Pick start and end dates", "warn");
  if (endDate < startDate) return notice("End date is before start date", "warn");
  if (!(hoursPerDay > 0 && hoursPerDay <= 24)) return notice("Hours per day must be between 0 and 24", "warn");

  const submitBtn = document.getElementById("req-submit-btn");
  submitBtn.disabled = true;
  try {
    const { error } = await sb.rpc("submit_leave_request", {
      p_leave_type_id: typeId,
      p_start_date: startDate,
      p_end_date: endDate,
      p_hours_per_day: hoursPerDay,
      p_skip_weekends: skipWeekends,
      p_reason: reason,
    });
    if (error) throw error;
    dialog.close();
    notice("Leave request submitted", "success");
    await loadRequests();
  } catch (err) {
    notice(err.message || "Failed to submit", "error");
  } finally {
    submitBtn.disabled = false;
  }
});

// ---------------------------------------------------------------- init

await loadLeaveTypes();
await loadRequests();
