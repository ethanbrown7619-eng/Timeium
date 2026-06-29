// PTL Timesheet — employee leave request page.
//
// Phase B of the leave workflow: shows the signed-in user's own leave
// history and lets them submit new requests via the submit_leave_request
// RPC. Status follows the two-step state machine from migration 126;
// cancellation is restricted to pre-approval statuses.

import { getSupabase } from "/js/supabase-client.js";
import {
  notice, escapeHtml, renderTopbar, getUserContext,
  fmtDate, fmtHours, leaveTotalHours, confirmDialog, promptDialog,
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
const isAdminOrDev = isDeveloper || adminRow?.role === "admin";
const canReviewTeam = isManager || isAdminOrDev;

renderTopbar({
  sb, session, isDeveloper, isManager, isClockViewer, adminRow,
  orgs: null, currentOrgId, onOrgChange: () => {},
  active: "leave",
});

// ---------------------------------------------------------------- tabs

// The Team Requests tab only exists for people who manage a department
// (or admins). A pure employee never sees it.
if (canReviewTeam) {
  document.getElementById("leave-team-tab").style.display = "";
}

document.querySelectorAll("[data-leave-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-leave-tab]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.leaveTab;
    document.getElementById("leave-tab-mine").style.display = tab === "mine" ? "" : "none";
    document.getElementById("leave-tab-team").style.display = tab === "team" ? "" : "none";
    if (tab === "team") loadTeamRequests();
  });
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
    .select("id, leave_type_id, start_date, end_date, hours_per_day, skip_weekends, reason, status, manager_review_note, review_note, change_request_type, change_requested_at, created_at, leave_types ( name )")
    .eq("user_id", employee.id)
    .order("created_at", { ascending: false });
  if (error) {
    body.innerHTML = `<tr><td colspan="9" class="muted small" style="text-align:center;color:#c00">${escapeHtml(error.message)}</td></tr>`;
    return;
  }
  const rows = data || [];
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="9" class="muted small" style="text-align:center;padding:24px">No leave requests yet. Click "Request leave" to submit one.</td></tr>`;
    return;
  }

  body.innerHTML = rows.map((r) => {
    const typeName = r.leave_types?.name || "—";
    const noteParts = [];
    if (r.reason)              noteParts.push(escapeHtml(r.reason));
    if (r.manager_review_note) noteParts.push(`<em class="muted small">Manager: ${escapeHtml(r.manager_review_note)}</em>`);
    if (r.review_note)         noteParts.push(`<em class="muted small">Admin: ${escapeHtml(r.review_note)}</em>`);
    if (r.change_request_type) noteParts.push(`<em class="small" style="color:var(--warning)">${r.change_request_type === "cancel" ? "Cancellation" : "Amendment"} requested — awaiting admin</em>`);
    const reasonCell = noteParts.length ? noteParts.join("<br>") : `<span class="muted small">—</span>`;

    const total = leaveTotalHours(r.start_date, r.end_date, r.hours_per_day, r.skip_weekends);
    return `<tr>
      <td>${escapeHtml(typeName)}</td>
      <td class="small">${escapeHtml(r.start_date || "")}</td>
      <td class="small">${escapeHtml(r.end_date || "")}</td>
      <td class="num small">${fmtHours(r.hours_per_day)}</td>
      <td class="num small"><strong>${fmtHours(total)}</strong></td>
      <td>${statusBadge(r.status)}</td>
      <td class="small">${reasonCell}</td>
      <td class="small muted">${r.created_at ? new Date(r.created_at).toLocaleString() : ""}</td>
      <td class="small" style="text-align:right">${rowMenu(r)}</td>
    </tr>`;
  }).join("");

  wireRowMenus();
}

// Build the per-row 3-dot menu. Pending requests can be cancelled
// outright; approved requests can request a cancellation or amendment
// (which an admin must action). Anything with a change already pending,
// or terminal (rejected/cancelled), gets no menu.
function rowMenu(r) {
  const items = [];
  if (r.status === "pending_manager" || r.status === "pending_admin") {
    items.push(`<button type="button" class="row-menu-item delete-entry-btn" role="menuitem" data-act="cancel" data-id="${r.id}">Cancel request</button>`);
  } else if (r.status === "approved" && !r.change_request_type) {
    items.push(`<button type="button" class="row-menu-item" role="menuitem" data-act="req-cancel" data-id="${r.id}">Request cancellation</button>`);
    items.push(`<button type="button" class="row-menu-item" role="menuitem" data-act="req-amend" data-id="${r.id}">Request amendment</button>`);
  }
  if (!items.length) return "";
  return `
    <div class="row-menu-wrap">
      <button type="button" class="ghost small row-menu-btn" aria-label="Options" aria-expanded="false">⋯</button>
      <div class="row-menu" hidden role="menu">${items.join("")}</div>
    </div>`;
}

function closeRowMenus() {
  document.querySelectorAll("#leave-list-body .row-menu").forEach((m) => { m.hidden = true; });
}

function wireRowMenus() {
  document.querySelectorAll("#leave-list-body .row-menu-btn").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const menu = btn.parentElement.querySelector(".row-menu");
      const willOpen = menu.hidden;
      closeRowMenus();
      if (!willOpen) return;
      // The menu lives inside a table wrapper with overflow:auto, which
      // clips an absolutely-positioned dropdown. Position it fixed,
      // anchored to the button, so it floats above everything.
      menu.hidden = false;
      menu.style.position = "fixed";
      const r = btn.getBoundingClientRect();
      const left = Math.max(8, r.right - menu.offsetWidth);
      // If the menu would overflow the bottom of the viewport, open it
      // upward instead.
      const top = (r.bottom + menu.offsetHeight > window.innerHeight - 8)
        ? r.top - menu.offsetHeight
        : r.bottom;
      menu.style.top = `${Math.max(8, top)}px`;
      menu.style.left = `${left}px`;
      menu.style.right = "auto";
    });
  });
  document.querySelectorAll("#leave-list-body .row-menu-item").forEach((item) => {
    item.addEventListener("click", () => onMenuAction(item.dataset.act, Number(item.dataset.id)));
  });
}

document.addEventListener("click", closeRowMenus);
window.addEventListener("scroll", closeRowMenus, true);

async function onMenuAction(act, id) {
  if (act === "cancel") {
    const ok = await confirmDialog({
      title: "Cancel leave request",
      message: "Withdraw this leave request? You'd need to submit a new one to reinstate it.",
      confirmText: "Cancel request", danger: true,
    });
    if (!ok) return;
    const { error } = await sb.rpc("cancel_leave_request", { p_request_id: id });
    if (error) return notice(error.message, "error");
    notice("Leave request cancelled", "success");
    await loadRequests();
  } else if (act === "req-cancel") {
    const ok = await confirmDialog({
      title: "Request cancellation",
      message: "This leave is already approved and on your timesheet. Ask an admin to cancel it?",
      confirmText: "Request cancellation",
    });
    if (!ok) return;
    const { error } = await sb.rpc("request_leave_change", { p_request_id: id, p_type: "cancel", p_note: null });
    if (error) return notice(error.message, "error");
    notice("Cancellation requested — an admin will action it", "success");
    await loadRequests();
  } else if (act === "req-amend") {
    const note = await promptDialog({
      title: "Request amendment",
      message: "What needs to change? (dates, hours, etc.) An admin will action it.",
      placeholder: "e.g. change Friday to a half day",
    });
    if (note == null) return; // cancelled the prompt
    const { error } = await sb.rpc("request_leave_change", { p_request_id: id, p_type: "amend", p_note: note.trim() || null });
    if (error) return notice(error.message, "error");
    notice("Amendment requested — an admin will action it", "success");
    await loadRequests();
  }
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

// ---------------------------------------------------------------- team review

function setTeamCountBadge(n) {
  const badge = document.getElementById("leave-team-count");
  if (!badge) return;
  if (n > 0) { badge.textContent = String(n); badge.style.display = ""; }
  else { badge.style.display = "none"; }
}

function teamDateRange(r) {
  return r.start_date === r.end_date ? r.start_date : `${r.start_date} → ${r.end_date}`;
}

async function loadTeamRequests() {
  await Promise.all([loadTeamPending(), loadTeamForwarded()]);
}

// pending_manager requests for the caller's managed team. Read via the
// SECURITY DEFINER RPC (migration 130) because RLS won't show other
// people's requests to a non-admin department lead.
async function loadTeamPending() {
  const body = document.getElementById("team-pending-body");
  if (!body) return;
  const { data, error } = await sb.rpc("list_team_leave_requests", {
    p_org_id: currentOrgId,
    p_status: "pending_manager",
  });
  if (error) {
    body.innerHTML = `<tr><td colspan="6" class="muted small" style="text-align:center;color:#c00">${escapeHtml(error.message)}</td></tr>`;
    return;
  }
  const rows = data || [];
  setTeamCountBadge(rows.length);
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="7" class="muted small" style="text-align:center;padding:16px">No requests waiting on your review.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((r) => {
    const total = leaveTotalHours(r.start_date, r.end_date, r.hours_per_day, r.skip_weekends);
    return `
    <tr data-id="${r.id}">
      <td>${escapeHtml(r.employee_name || "")}</td>
      <td>${escapeHtml(r.leave_type_name || "")}</td>
      <td class="small">${teamDateRange(r)}</td>
      <td class="num">${fmtHours(r.hours_per_day)}</td>
      <td class="num"><strong>${fmtHours(total)}</strong></td>
      <td class="small muted">${escapeHtml(r.reason || "")}</td>
      <td style="white-space:nowrap">
        <button class="small approve-tr-btn">Approve</button>
        <button class="ghost small reject-tr-btn">Reject</button>
      </td>
    </tr>`;
  }).join("");

  body.querySelectorAll(".approve-tr-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.closest("tr").dataset.id);
      if (!await confirmDialog({ title: "Approve leave", message: "Approve this request and send it to an admin for final sign-off?", confirmText: "Approve" })) return;
      const { error: e } = await sb.rpc("manager_approve_leave_request", { p_request_id: id, p_note: null });
      if (e) return notice(e.message, "error");
      notice("Approved — sent to admin for final sign-off", "success");
      await loadTeamRequests();
    });
  });
  body.querySelectorAll(".reject-tr-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.closest("tr").dataset.id);
      const note = await promptDialog({ title: "Reject leave", message: "Reason for rejection (optional):" }) || null;
      const { error: e } = await sb.rpc("manager_reject_leave_request", { p_request_id: id, p_note: note });
      if (e) return notice(e.message, "error");
      notice("Leave request rejected", "success");
      await loadTeamRequests();
    });
  });
}

// pending_admin requests this manager already forwarded — read-only.
async function loadTeamForwarded() {
  const body = document.getElementById("team-forwarded-body");
  if (!body) return;
  const { data, error } = await sb.rpc("list_team_leave_requests", {
    p_org_id: currentOrgId,
    p_status: "pending_admin",
  });
  if (error) {
    body.innerHTML = `<tr><td colspan="5" class="muted small" style="text-align:center;color:#c00">${escapeHtml(error.message)}</td></tr>`;
    return;
  }
  const rows = data || [];
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="6" class="muted small" style="text-align:center;padding:16px">Nothing awaiting admin sign-off.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((r) => {
    const total = leaveTotalHours(r.start_date, r.end_date, r.hours_per_day, r.skip_weekends);
    return `
    <tr>
      <td>${escapeHtml(r.employee_name || "")}</td>
      <td>${escapeHtml(r.leave_type_name || "")}</td>
      <td class="small">${teamDateRange(r)}</td>
      <td class="num">${fmtHours(r.hours_per_day)}</td>
      <td class="num"><strong>${fmtHours(total)}</strong></td>
      <td class="small muted">${escapeHtml(r.reason || "")}</td>
    </tr>`;
  }).join("");
}

// ---------------------------------------------------------------- init

await loadLeaveTypes();
await loadRequests();
// Pre-load the team pending count so the badge shows on first paint even
// while the My Requests tab is active.
if (canReviewTeam) loadTeamPending();
