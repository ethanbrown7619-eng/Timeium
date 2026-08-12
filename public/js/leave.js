// PTL Timesheet — employee leave request page.
//
// Shows the signed-in user's own leave history and lets them submit new
// requests via the submit_leave_request RPC. Manager approval is final
// (migration 150) — approving populates the timesheet immediately.
// Managers can also raise leave on behalf of their team; those land at
// pending_employee and the employee accepts/declines from My Requests.

import { getSupabase } from "/js/supabase-client.js";
import {
  notice, escapeHtml, renderTopbar, getUserContext,
  fmtDate, fmtHours, leaveTotalHours, confirmDialog, promptDialog,
  refreshLeaveBadge,
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

// Staff whose type receives no leave (e.g. contractors) don't get the Leave
// tab; block direct /leave.html access too — unless they manage a team or
// are an admin, who need it for Team Requests.
if (ctx.receivesLeave === false && !canReviewTeam) {
  location.replace("/timesheet.html");
  throw new Error("staff type does not receive leave");
}

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

// On the Team tab the request button switches to on-behalf mode: the
// manager picks one of their team and the employee has to accept.
let activeLeaveTab = "mine";

document.querySelectorAll("[data-leave-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-leave-tab]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.leaveTab;
    activeLeaveTab = tab;
    document.getElementById("leave-tab-mine").style.display = tab === "mine" ? "" : "none";
    document.getElementById("leave-tab-team").style.display = tab === "team" ? "" : "none";
    document.getElementById("leave-tab-calendar").style.display = tab === "calendar" ? "" : "none";
    document.getElementById("open-request-btn").textContent =
      tab === "team" ? "+ Request on behalf" : "+ Request leave";
    if (tab === "team") loadTeamRequests();
    if (tab === "calendar") mountCalendarOnce();
  });
});

// ---------------------------------------------------------------- calendar
// Org-wide approved leave as a month grid, privacy-limited to
// "Name — Leave" (the org_leave_calendar RPC). Lazy-mounted on first open;
// leave-calendar.js caches months for the page's life after that.

let leaveCalMounted = false;

function mountCalendarOnce() {
  if (leaveCalMounted) return;
  leaveCalMounted = true;
  import("/js/leave-calendar.js")
    .then(({ mountLeaveCalendar }) => {
      mountLeaveCalendar(document.getElementById("leavecal-host"), sb, currentOrgId).load();
    })
    .catch((err) => {
      leaveCalMounted = false;
      console.warn("leave calendar failed to load:", err);
      notice("Couldn't load the leave calendar", "error");
    });
}

// ---------------------------------------------------------------- data

let leaveTypes = [];
let leaveRows = [];      // most recent My Requests rows (for amend prefill)
let amendingId = null;       // request id being amended, or null in create mode
let editingPendingId = null; // pending_employee request being edited by manager/admin
let editingPendingName = ""; // employee name for that request (dialog copy)

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
    case "pending_employee": return `<span class="dept-badge dept-badge-submitted">Awaiting your acceptance</span>`;
    case "pending_manager": return `<span class="dept-badge dept-badge-draft">Pending approval</span>`;
    case "pending_admin":   return `<span class="dept-badge dept-badge-draft">Pending approval</span>`;
    case "approved":        return `<span class="dept-badge dept-badge-approved">Approved</span>`;
    case "rejected":        return `<span class="dept-badge dept-badge-rejected">Rejected</span>`;
    case "cancelled":       return `<span class="dept-badge dept-badge-none">Cancelled</span>`;
    default:                return `<span class="dept-badge dept-badge-none">${escapeHtml(status || "")}</span>`;
  }
}

async function loadRequests() {
  const body = document.getElementById("leave-list-body");
  // Pin the leave_types embed to the leave_type_id FK — leave_requests
  // now also has proposed_leave_type_id, so a bare leave_types(name)
  // embed is ambiguous.
  const { data, error } = await sb.from("leave_requests")
    .select("id, leave_type_id, start_date, end_date, hours_per_day, skip_weekends, reason, status, manager_review_note, review_note, change_request_type, change_requested_at, created_at, leave_types!leave_requests_leave_type_id_fkey ( name ), requested_by_user:users!leave_requests_requested_by_fkey ( name )")
    .eq("user_id", employee.id)
    .is("dismissed_at", null)   // rows the employee dismissed stay hidden
    .order("created_at", { ascending: false });
  if (error) {
    body.innerHTML = `<tr><td colspan="9" class="muted small" style="text-align:center;color:#c00">${escapeHtml(error.message)}</td></tr>`;
    return;
  }
  const rows = data || [];
  leaveRows = rows;
  // Keep the topbar's Leave pill in step — accepting or declining here must
  // clear it without needing a reload.
  refreshLeaveBadge(sb).catch(() => {});
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="9" class="muted small" style="text-align:center;padding:24px">No leave requests yet. Click "Request leave" to submit one.</td></tr>`;
    return;
  }

  body.innerHTML = rows.map((r) => {
    const typeName = r.leave_types?.name || "—";
    const noteParts = [];
    if (r.reason)              noteParts.push(escapeHtml(r.reason));
    if (r.status === "pending_employee") noteParts.push(`<em class="small" style="color:var(--warning)">Requested on your behalf${r.requested_by_user?.name ? ` by ${escapeHtml(r.requested_by_user.name)}` : ""} — accept or decline via ⋯</em>`);
    if (r.manager_review_note) noteParts.push(`<em class="muted small">Manager: ${escapeHtml(r.manager_review_note)}</em>`);
    if (r.review_note)         noteParts.push(`<em class="muted small">Reviewer: ${escapeHtml(r.review_note)}</em>`);
    if (r.change_request_type) noteParts.push(`<em class="small" style="color:var(--warning)">${r.change_request_type === "cancel" ? "Cancellation" : "Amendment"} requested — awaiting your manager</em>`);
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

  wireRowMenus(rows);
}

// Which actions a row offers. Manager-raised requests must be accepted
// or declined; pending requests can be cancelled outright; approved
// requests can request a cancellation or amendment. Anything with a
// change already pending, or terminal, has none.
function rowActions(r) {
  if (r.status === "pending_employee") {
    return [
      { act: "accept", label: "Accept — add to my timesheet" },
      { act: "decline", label: "Decline", danger: true },
    ];
  }
  if (r.status === "pending_manager" || r.status === "pending_admin") {
    return [{ act: "cancel", label: "Cancel request", danger: true }];
  }
  if (r.status === "approved" && !r.change_request_type) {
    return [
      { act: "req-cancel", label: "Request cancellation" },
      { act: "req-amend", label: "Request amendment" },
    ];
  }
  // Finished requests can be dismissed from the list (display-only —
  // admins still see the full history).
  if (r.status === "rejected" || r.status === "cancelled") {
    return [{ act: "dismiss", label: "Dismiss from my list" }];
  }
  return [];
}

function rowMenu(r) {
  if (!rowActions(r).length) return "";
  return `<button type="button" class="ghost small leave-menu-btn" data-id="${r.id}" aria-label="Options">⋯</button>`;
}

const actionDialog = document.getElementById("leave-action-dialog");
document.getElementById("leave-action-close").addEventListener("click", () => actionDialog.close());

function wireRowMenus(rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  document.querySelectorAll("#leave-list-body .leave-menu-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.id);
      const r = byId.get(id);
      if (!r) return;
      const acts = rowActions(r);
      document.getElementById("leave-action-title").textContent =
        `${r.leave_types?.name || "Leave"} · ${r.start_date}${r.end_date !== r.start_date ? ` → ${r.end_date}` : ""}`;
      document.getElementById("leave-action-sub").textContent = "Choose an action for this leave request.";
      const box = document.getElementById("leave-action-buttons");
      box.innerHTML = acts.map((a) =>
        `<button type="button" class="${a.danger ? "danger" : "primary"}" data-act="${a.act}" data-id="${id}" style="width:100%">${a.label}</button>`
      ).join("");
      box.querySelectorAll("button").forEach((b) => {
        b.addEventListener("click", () => {
          actionDialog.close();
          onMenuAction(b.dataset.act, Number(b.dataset.id));
        });
      });
      actionDialog.showModal();
    });
  });
}

async function onMenuAction(act, id) {
  if (act === "dismiss") {
    const { error } = await sb.rpc("dismiss_my_leave_request", { p_request_id: id });
    if (error) return notice(error.message, "error");
    notice("Request dismissed", "success");
    await loadRequests();
  } else if (act === "accept") {
    const ok = await confirmDialog({
      title: "Accept leave request",
      message: "Accept this leave? It'll be approved and the hours added to your timesheet automatically.",
      confirmText: "Accept",
    });
    if (!ok) return;
    const { error } = await sb.rpc("accept_leave_request", { p_request_id: id });
    if (error) return notice(error.message, "error");
    notice("Leave accepted — added to your timesheet", "success");
    await loadRequests();
  } else if (act === "decline") {
    const note = await promptDialog({ title: "Decline leave request", message: "Reason for declining (optional):" }) || null;
    const { error } = await sb.rpc("decline_leave_request", { p_request_id: id, p_note: note });
    if (error) return notice(error.message, "error");
    notice("Leave request declined", "success");
    await loadRequests();
  } else if (act === "cancel") {
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
      message: "This leave is already approved and on your timesheet. Ask your manager to cancel it?",
      confirmText: "Request cancellation",
    });
    if (!ok) return;
    const { error } = await sb.rpc("request_leave_change", { p_request_id: id, p_type: "cancel", p_note: null });
    if (error) return notice(error.message, "error");
    notice("Cancellation requested — your manager will action it", "success");
    await loadRequests();
  } else if (act === "req-amend") {
    // Open the request modal pre-filled with the current leave so the
    // employee can change it to what they'd like instead.
    const r = leaveRows.find((x) => x.id === id);
    if (!r) return;
    openRequestModal({
      amendId: id,
      typeId: r.leave_type_id,
      start: r.start_date,
      // req-end is "return to work" = last leave day + 1.
      returnDate: addDaysIso(r.end_date, 1),
      hours: r.hours_per_day,
      skipWeekends: r.skip_weekends,
      reason: r.reason || "",
    });
  }
}

function addDaysIso(iso, n) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}

// ---------------------------------------------------------------- modal

const dialog = document.getElementById("request-dialog");
const form = document.getElementById("request-form");

// The hours the form defaults to, i.e. what it treats as a whole day. Only
// used to spot a partial-day request that still says 8 hours.
const FULL_DAY_HOURS = 8;

// The "Return to work on" field is the first day BACK at work, so the last
// leave day is the day before it.
//
// The exception is a PARTIAL DAY: returning to work on the start date itself
// means taking part of that day and working the rest, so the leave is that one
// day rather than the day before it. Without the start date the caller gets the
// old behaviour, which is what the amend/edit prefills want.
function returnToEndDate(returnIso, startIso) {
  if (!returnIso) return "";
  if (startIso && returnIso === startIso) return startIso;
  const d = new Date(returnIso + "T00:00:00");
  if (isNaN(d)) return "";
  d.setDate(d.getDate() - 1);
  return fmtDate(d);
}

// Live total shown in the modal as the inputs change.
function updateRequestTotal() {
  const start = document.getElementById("req-start").value;
  const ret = document.getElementById("req-end").value;
  const hours = Number(document.getElementById("req-hours").value);
  const skip = document.getElementById("req-skip-weekends").checked;
  const end = returnToEndDate(ret, start);
  const partialDay = !!start && ret === start;
  const totalEl = document.getElementById("req-total");
  const daysEl = document.getElementById("req-total-days");
  if (!end || end < start || !(hours > 0)) {
    totalEl.textContent = "0 hours";
    daysEl.textContent = "";
    return;
  }
  const total = leaveTotalHours(start, end, hours, skip);
  const days = hours > 0 ? Math.round(total / hours) : 0;
  totalEl.textContent = `${fmtHours(total)} hour${total === 1 ? "" : "s"}`;
  if (partialDay) {
    // Hours still at the whole-day default is the likely mistake here — they
    // came for a part day and would book the lot.
    daysEl.textContent = hours >= FULL_DAY_HOURS
      ? `(part of ${end} — set the hours to the time you're actually taking)`
      : `(part of ${end})`;
  } else {
    daysEl.textContent = `(${days} day${days === 1 ? "" : "s"}, last day ${end})`;
  }
}

["req-start", "req-end", "req-hours", "req-skip-weekends"].forEach((id) => {
  const el = document.getElementById(id);
  el.addEventListener("input", updateRequestTotal);
  el.addEventListener("change", updateRequestTotal);
});

// Open the request modal. With no prefill it's a fresh request; with a
// prefill (from "Request amendment") it's pre-populated and submitting
// proposes an amendment instead of creating a new request. With
// { behalf: true } (Team tab) the manager picks a team member and the
// request goes to that employee for acceptance.
let behalfMode = false;
let managedEmployeesLoaded = false;

async function loadManagedEmployees() {
  if (managedEmployeesLoaded) return;
  const sel = document.getElementById("req-behalf-user");
  const { data, error } = await sb.rpc("list_managed_employees", { p_org_id: currentOrgId });
  if (error) { notice(`Could not load your team: ${error.message}`, "error"); return; }
  sel.innerHTML = (data || []).map((u) =>
    `<option value="${u.id}">${escapeHtml(u.name)}</option>`
  ).join("");
  managedEmployeesLoaded = true;
}

function openRequestModal(prefill = null) {
  amendingId = prefill?.amendId || null;
  editingPendingId = prefill?.editPendingId || null;
  editingPendingName = prefill?.editPendingName || "the employee";
  const isAmend = !!amendingId;
  const isEditPending = !!editingPendingId;
  behalfMode = !!prefill?.behalf && !isAmend && !isEditPending;

  document.getElementById("req-behalf-wrap").style.display = behalfMode ? "" : "none";
  // The withdraw button only makes sense while editing an on-behalf
  // request the employee hasn't accepted yet.
  document.getElementById("req-withdraw-btn").style.display = isEditPending ? "" : "none";
  if (behalfMode) loadManagedEmployees();

  document.getElementById("request-dialog-title").textContent =
    isEditPending ? `Edit request for ${prefill.editPendingName}`
    : isAmend ? "Request amendment"
    : behalfMode ? "Request leave on behalf" : "Request leave";
  document.getElementById("req-submit-btn").textContent =
    isEditPending ? "Save changes"
    : isAmend ? "Request amendment"
    : behalfMode ? "Send to employee" : "Submit request";

  if (isAmend || isEditPending) {
    document.getElementById("req-type").value = String(prefill.typeId);
    document.getElementById("req-start").value = prefill.start;
    document.getElementById("req-end").value = prefill.returnDate;
    document.getElementById("req-hours").value = prefill.hours;
    document.getElementById("req-skip-weekends").checked = !!prefill.skipWeekends;
    document.getElementById("req-reason").value = prefill.reason || "";
  } else {
    const today = new Date();
    const tmrw = new Date(today.getTime() + 86400000);
    document.getElementById("req-start").value = fmtDate(today);
    document.getElementById("req-end").value = fmtDate(tmrw);
    document.getElementById("req-hours").value = 8;
    document.getElementById("req-skip-weekends").checked = true;
    document.getElementById("req-reason").value = "";
  }
  updateRequestTotal();
  dialog.showModal();
}

document.getElementById("open-request-btn").addEventListener("click", () =>
  openRequestModal(activeLeaveTab === "team" && canReviewTeam ? { behalf: true } : null));

document.getElementById("req-cancel-btn").addEventListener("click", () => { amendingId = null; editingPendingId = null; dialog.close(); });

// Withdraw the on-behalf request being edited (edit-pending mode only).
document.getElementById("req-withdraw-btn").addEventListener("click", async () => {
  if (!editingPendingId) return;
  const ok = await confirmDialog({
    title: "Cancel request",
    message: `Withdraw this leave request for ${editingPendingName}? They won't need to respond to it.`,
    confirmText: "Cancel request", danger: true,
  });
  if (!ok) return;
  const { error } = await sb.rpc("cancel_pending_leave_request", { p_request_id: editingPendingId, p_note: null });
  if (error) return notice(error.message, "error");
  editingPendingId = null;
  dialog.close();
  notice("Request withdrawn", "success");
  loadTeamRequests();
});

form.addEventListener("submit", async (e) => {
  // Default form submit on the dialog calls dialog.close() because
  // method="dialog"; we want to call the RPC first.
  e.preventDefault();

  const typeId = Number(document.getElementById("req-type").value);
  const startDate = document.getElementById("req-start").value;
  const returnDate = document.getElementById("req-end").value;
  // Last leave day = the day before returning, EXCEPT a partial day, where
  // returning on the start date leaves the leave on that same date.
  const endDate = returnToEndDate(returnDate, startDate);
  const hoursPerDay = Number(document.getElementById("req-hours").value);
  const skipWeekends = document.getElementById("req-skip-weekends").checked;
  const reason = document.getElementById("req-reason").value.trim() || null;

  if (!typeId) return notice("Pick a leave type", "warn");
  if (!startDate || !returnDate) return notice("Pick a start date and a return-to-work date", "warn");
  if (returnDate < startDate) return notice("Return-to-work date can't be before the start date", "warn");
  if (!(hoursPerDay > 0 && hoursPerDay <= 24)) return notice("Hours per day must be between 0 and 24", "warn");
  // Skip-weekends is on by default, so a single Saturday or Sunday request
  // would otherwise be accepted and then populate nothing at all.
  if (leaveTotalHours(startDate, endDate, hoursPerDay, skipWeekends) <= 0) {
    return notice("That request adds up to no leave — check the dates, or untick Skip weekends", "warn");
  }

  const submitBtn = document.getElementById("req-submit-btn");
  submitBtn.disabled = true;
  try {
    if (editingPendingId) {
      const { error } = await sb.rpc("update_pending_leave_request", {
        p_request_id: editingPendingId,
        p_leave_type_id: typeId,
        p_start_date: startDate,
        p_end_date: endDate,
        p_hours_per_day: hoursPerDay,
        p_skip_weekends: skipWeekends,
        p_reason: reason,
      });
      if (error) throw error;
      dialog.close();
      editingPendingId = null;
      notice("Request updated — the employee sees the new details", "success");
      loadTeamRequests();
    } else if (amendingId) {
      const { error } = await sb.rpc("request_leave_amendment", {
        p_request_id: amendingId,
        p_leave_type_id: typeId,
        p_start_date: startDate,
        p_end_date: endDate,
        p_hours_per_day: hoursPerDay,
        p_skip_weekends: skipWeekends,
        p_reason: reason,
      });
      if (error) throw error;
      dialog.close();
      amendingId = null;
      notice("Amendment requested — your manager will review it", "success");
    } else if (behalfMode) {
      const targetSel = document.getElementById("req-behalf-user");
      const targetId = Number(targetSel.value);
      if (!targetId) throw new Error("Pick an employee to request leave for");
      const targetName = targetSel.options[targetSel.selectedIndex]?.textContent || "the employee";
      const { error } = await sb.rpc("submit_leave_request_on_behalf", {
        p_user_id: targetId,
        p_leave_type_id: typeId,
        p_start_date: startDate,
        p_end_date: endDate,
        p_hours_per_day: hoursPerDay,
        p_skip_weekends: skipWeekends,
        p_reason: reason,
      });
      if (error) throw error;
      dialog.close();
      behalfMode = false;
      notice(`Request sent — awaiting ${targetName}'s acceptance`, "success");
      loadTeamRequests();
    } else {
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
    }
    await loadRequests();
  } catch (err) {
    notice(err.message || "Failed to submit", "error");
  } finally {
    submitBtn.disabled = false;
  }
});

// ---------------------------------------------------------------- team review

// The Team tab badge counts everything waiting on the manager: pending
// approvals plus change requests. Each loader updates its slice and
// re-renders the combined badge.
const teamCounts = { pending: 0, changes: 0 };

function setBadgeEl(id, n) {
  const badge = document.getElementById(id);
  if (!badge) return;
  if (n > 0) { badge.textContent = String(n); badge.style.display = ""; }
  else { badge.style.display = "none"; }
}

function setTeamCountBadge() {
  setBadgeEl("leave-team-count", teamCounts.pending + teamCounts.changes);
  setBadgeEl("leave-changes-count", teamCounts.changes);
}

function teamDateRange(r) {
  return r.start_date === r.end_date ? r.start_date : `${r.start_date} → ${r.end_date}`;
}

async function loadTeamRequests() {
  await Promise.all([loadTeamPending(), loadTeamChanges(), loadTeamAwaiting()]);
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
    body.innerHTML = `<tr><td colspan="7" class="muted small" style="text-align:center;color:#c00">${escapeHtml(error.message)}</td></tr>`;
    return;
  }
  const rows = data || [];
  teamCounts.pending = rows.length;
  setTeamCountBadge();
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
      if (!await confirmDialog({ title: "Approve leave", message: "Approve this request? The employee's timesheet will be populated with the leave hours automatically.", confirmText: "Approve" })) return;
      const { error: e } = await sb.rpc("manager_approve_leave_request", { p_request_id: id, p_note: null });
      if (e) return notice(e.message, "error");
      notice("Approved — timesheet populated", "success");
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

// Cancellation/amendment requests on approved leave for the manager's
// team (migration 152). Apply swaps in the proposed values, Revoke pulls
// the leave off the timesheet, Dismiss keeps the leave as-is.
async function loadTeamChanges() {
  const body = document.getElementById("team-changes-body");
  if (!body) return;
  const { data, error } = await sb.rpc("list_team_leave_change_requests", { p_org_id: currentOrgId });
  if (error) {
    body.innerHTML = `<tr><td colspan="6" class="muted small" style="text-align:center;color:#c00">${escapeHtml(error.message)}</td></tr>`;
    return;
  }
  const rows = data || [];
  teamCounts.changes = rows.length;
  setTeamCountBadge();
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="6" class="muted small" style="text-align:center;padding:16px">No cancellation or amendment requests.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((r) => {
    const isAmend = r.change_request_type === "amend" && r.proposed_start_date;
    const label = r.change_request_type === "cancel" ? "Cancellation" : "Amendment";
    let detail = r.change_request_note ? `: ${escapeHtml(r.change_request_note)}` : "";
    if (isAmend) {
      const pRange = r.proposed_start_date === r.proposed_end_date
        ? r.proposed_start_date : `${r.proposed_start_date} → ${r.proposed_end_date}`;
      const pTotal = leaveTotalHours(r.proposed_start_date, r.proposed_end_date, r.proposed_hours_per_day, r.proposed_skip_weekends);
      const pType = r.proposed_leave_type_name && r.proposed_leave_type_name !== r.leave_type_name
        ? `${escapeHtml(r.proposed_leave_type_name)}, ` : "";
      detail = ` → change to ${pType}${escapeHtml(pRange)}, ${fmtHours(r.proposed_hours_per_day)}h/day (${fmtHours(pTotal)}h total)`;
    }
    return `
    <tr data-id="${r.id}">
      <td>${escapeHtml(r.employee_name || "")}</td>
      <td>${escapeHtml(r.leave_type_name || "")}</td>
      <td class="small">${teamDateRange(r)}</td>
      <td class="num">${fmtHours(r.hours_per_day)}</td>
      <td class="small"><em style="color:var(--warning)">${label} requested</em>${detail}</td>
      <td style="white-space:nowrap">
        ${isAmend ? `<button class="small apply-tc-btn">Apply</button>` : ""}
        <button class="${isAmend ? "ghost " : ""}small revoke-tc-btn">Revoke</button>
        <button class="ghost small dismiss-tc-btn">Dismiss</button>
      </td>
    </tr>`;
  }).join("");

  body.querySelectorAll(".apply-tc-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.closest("tr").dataset.id);
      if (!await confirmDialog({ title: "Apply amendment", message: "Apply the employee's proposed changes? The old leave hours are removed from their timesheet and the new ones populated.", confirmText: "Apply" })) return;
      const { error: e } = await sb.rpc("apply_leave_amendment", { p_request_id: id });
      if (e) return notice(e.message, "error");
      notice("Amendment applied", "success");
      await loadTeamRequests();
    });
  });
  body.querySelectorAll(".revoke-tc-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.closest("tr").dataset.id);
      if (!await confirmDialog({ title: "Revoke leave", message: "Cancel this approved leave and remove the hours from the employee's timesheet?", confirmText: "Revoke", danger: true })) return;
      const { error: e } = await sb.rpc("revoke_leave_request", { p_request_id: id, p_note: null });
      if (e) return notice(e.message, "error");
      notice("Leave revoked and removed from timesheet", "success");
      await loadTeamRequests();
    });
  });
  body.querySelectorAll(".dismiss-tc-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.closest("tr").dataset.id);
      if (!await confirmDialog({ title: "Dismiss change request", message: "Clear the change request and keep the leave as approved?", confirmText: "Dismiss" })) return;
      const { error: e } = await sb.rpc("dismiss_leave_change_request", { p_request_id: id });
      if (e) return notice(e.message, "error");
      notice("Change request dismissed", "success");
      await loadTeamRequests();
    });
  });
}

// pending_employee requests raised on behalf — the employee accepts or
// declines from their My Requests tab; until then the requester (or an
// admin) can Edit the details to fix a mistake.
async function loadTeamAwaiting() {
  const body = document.getElementById("team-awaiting-body");
  if (!body) return;
  const { data, error } = await sb.rpc("list_team_leave_requests", {
    p_org_id: currentOrgId,
    p_status: "pending_employee",
  });
  if (error) {
    body.innerHTML = `<tr><td colspan="7" class="muted small" style="text-align:center;color:#c00">${escapeHtml(error.message)}</td></tr>`;
    return;
  }
  const rows = data || [];
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="7" class="muted small" style="text-align:center;padding:16px">Nothing awaiting employee acceptance.</td></tr>`;
    return;
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
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
      <td style="white-space:nowrap"><button class="ghost small edit-ta-btn">Edit</button></td>
    </tr>`;
  }).join("");

  // Edit a request the employee hasn't accepted yet — fixes a mistaken
  // date/type/hours without declining and re-raising. Opens the request
  // dialog prefilled; saving calls update_pending_leave_request.
  body.querySelectorAll(".edit-ta-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const r = byId.get(Number(btn.closest("tr").dataset.id));
      if (!r) return;
      openRequestModal({
        editPendingId: r.id,
        editPendingName: r.employee_name || "the employee",
        typeId: r.leave_type_id,
        start: r.start_date,
        returnDate: addDaysIso(r.end_date, 1),
        hours: r.hours_per_day,
        skipWeekends: r.skip_weekends,
        reason: r.reason || "",
      });
    });
  });

}

// ---------------------------------------------------------------- init

// Independent fetches — the requests table embeds its type names, so it
// doesn't need the leaveTypes list (that's for the request dialog).
await Promise.all([loadLeaveTypes(), loadRequests()]);
// Pre-load the team pending + change-request counts so the badge shows
// on first paint even while the My Requests tab is active.
if (canReviewTeam) { loadTeamPending(); loadTeamChanges(); }
