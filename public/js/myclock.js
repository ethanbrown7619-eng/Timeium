// PTL Timesheet — My Clock page.
// Shows the signed-in employee's own clock events (via the
// list_my_clock_events RPC — clock_events RLS is admin-only) and lets
// them request a time fix on any event, including auto-closed ones.
// Requests land in the Adjustments sub-tab of the Clock page where a
// clock viewer / admin approves or declines them (migration 146).

import { getSupabase } from "/js/supabase-client.js";
import {
  notice, escapeHtml, renderTopbar, getUserContext,
  getMonday, fmtDate, addDays, confirmDialog,
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

renderTopbar({
  sb, session, isDeveloper, isManager, isClockViewer, adminRow,
  orgs: null, currentOrgId: employee.organisation_id, onOrgChange: () => {},
  active: "myclock",
});

/* ---------------------------------------------------------------- helpers */

function fmtEventTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

function fmtEventDay(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

// datetime-local wants "YYYY-MM-DDTHH:MM" in LOCAL time.
function toLocalDT(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const STATUS_BADGE = {
  pending:  { label: "Pending",  cls: "dept-badge dept-badge-submitted" },
  approved: { label: "Approved", cls: "dept-badge dept-badge-approved" },
  declined: { label: "Declined", cls: "dept-badge dept-badge-rejected" },
};

/* ---------------------------------------------------------------- week nav */

let weekStart = getMonday(new Date());

function updateWeekLabel() {
  const end = addDays(weekStart, 6);
  document.getElementById("mc-week-label").textContent =
    `${weekStart.toLocaleDateString(undefined, { day: "numeric", month: "short" })} — ${end.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
}
updateWeekLabel();

document.getElementById("mc-prev").addEventListener("click", () => {
  weekStart = addDays(weekStart, -7);
  updateWeekLabel();
  loadEvents();
});
document.getElementById("mc-next").addEventListener("click", () => {
  weekStart = addDays(weekStart, 7);
  updateWeekLabel();
  loadEvents();
});

/* ---------------------------------------------------------------- events */

async function loadEvents() {
  const body = document.getElementById("mc-events-body");
  try {
    // Local-midnight week bounds as timestamptz — the RPC compares
    // against occurred_at directly, so no timezone drift.
    const start = new Date(weekStart); start.setHours(0, 0, 0, 0);
    const end = addDays(start, 7);
    const { data, error } = await sb.rpc("list_my_clock_events", {
      p_start:    start.toISOString(),
      p_end_excl: end.toISOString(),
    });
    if (error) throw error;
    const rows = data || [];
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="5" class="muted small" style="text-align:center;padding:16px">No clock events this week.</td></tr>`;
      return;
    }
    body.innerHTML = rows.map((r) => {
      const isIn = r.event_type === "in";
      const pill = `<span class="tc-live-pill ${isIn ? "onsite" : "away"}">${isIn ? "In" : "Out"}</span>`;
      const flags = [
        r.auto_closed ? `<span class="cvt-cell cvt-warn" style="padding:2px 8px;border-radius:999px;display:inline-block">Auto-closed</span>` : "",
        r.source ? `<span class="small muted">${escapeHtml(r.source)}</span>` : "",
      ].filter(Boolean).join(" ");
      const action = r.pending_request_id
        ? `<span class="small muted">Change requested</span>`
        : `<button class="ghost small mc-request-btn" data-event-id="${r.id}" data-type="${r.event_type}" data-time="${escapeHtml(r.occurred_at)}">Request fix</button>`;
      return `<tr>
        <td class="small">${escapeHtml(fmtEventDay(r.occurred_at))}</td>
        <td>${pill}</td>
        <td class="num">${escapeHtml(fmtEventTime(r.occurred_at))}</td>
        <td>${flags}</td>
        <td style="text-align:right">${action}</td>
      </tr>`;
    }).join("");

    body.querySelectorAll(".mc-request-btn").forEach((btn) => {
      btn.addEventListener("click", () => openAdjustDialog({
        eventId: Number(btn.dataset.eventId),
        type:    btn.dataset.type,
        time:    btn.dataset.time,
      }));
    });
  } catch (err) {
    console.error("clock events load failed:", err);
    body.innerHTML = `<tr><td colspan="5" class="muted small" style="text-align:center;padding:16px;color:#c00">${escapeHtml(err.message || "Could not load clock events")}</td></tr>`;
  }
}

/* ---------------------------------------------------------------- request dialog */

let dialogEventId = null;

function openAdjustDialog({ eventId, type, time }) {
  dialogEventId = eventId;
  document.getElementById("mc-adjust-summary").textContent =
    `Clock ${type === "in" ? "in" : "out"} recorded at ${fmtEventDay(time)} ${fmtEventTime(time)}. Enter what the time should have been.`;
  document.getElementById("mc-adjust-time").value = toLocalDT(time);
  document.getElementById("mc-adjust-reason").value = "";
  document.getElementById("mc-adjust-dialog").showModal();
}

document.getElementById("mc-adjust-cancel").addEventListener("click", () => {
  document.getElementById("mc-adjust-dialog").close();
});

document.getElementById("mc-adjust-submit").addEventListener("click", async () => {
  const val = document.getElementById("mc-adjust-time").value;
  if (!val) return notice("Enter the correct time", "warn");
  const requested = new Date(val);
  if (isNaN(requested)) return notice("Invalid time", "warn");
  const btn = document.getElementById("mc-adjust-submit");
  btn.disabled = true;
  try {
    const { error } = await sb.rpc("submit_clock_adjustment", {
      p_clock_event_id: dialogEventId,
      p_requested_time: requested.toISOString(),
      p_reason: document.getElementById("mc-adjust-reason").value.trim() || null,
    });
    if (error) throw error;
    document.getElementById("mc-adjust-dialog").close();
    notice("Adjustment requested — a reviewer will approve or decline it", "success");
    await Promise.all([loadEvents(), loadRequests()]);
  } catch (err) {
    notice(err.message || "Request failed", "error");
  } finally {
    btn.disabled = false;
  }
});

/* ---------------------------------------------------------------- my requests */

async function loadRequests() {
  const body = document.getElementById("mc-requests-body");
  try {
    const { data, error } = await sb
      .from("clock_adjustment_requests")
      .select("id, event_type, original_time, requested_time, reason, status, review_note, created_at")
      .eq("user_id", employee.id)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    const rows = data || [];
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="7" class="muted small" style="text-align:center;padding:16px">No adjustment requests yet.</td></tr>`;
      return;
    }
    body.innerHTML = rows.map((r) => {
      const b = STATUS_BADGE[r.status] || { label: r.status, cls: "dept-badge dept-badge-none" };
      const cancel = r.status === "pending"
        ? `<button class="ghost small mc-cancel-btn" data-id="${r.id}">Cancel</button>`
        : "";
      return `<tr>
        <td class="small">${escapeHtml(fmtEventDay(r.original_time))} · ${r.event_type === "in" ? "In" : "Out"}</td>
        <td class="num small">${escapeHtml(fmtEventTime(r.original_time))}</td>
        <td class="num small"><strong>${escapeHtml(fmtEventTime(r.requested_time))}</strong></td>
        <td class="small muted">${escapeHtml(r.reason || "")}</td>
        <td><span class="${b.cls}">${escapeHtml(b.label)}</span></td>
        <td class="small muted">${escapeHtml(r.review_note || "")}</td>
        <td style="text-align:right">${cancel}</td>
      </tr>`;
    }).join("");

    body.querySelectorAll(".mc-cancel-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!await confirmDialog({
          title: "Cancel request",
          message: "Cancel this adjustment request?",
          confirmText: "Cancel request",
          danger: true,
        })) return;
        const { error } = await sb
          .from("clock_adjustment_requests")
          .delete()
          .eq("id", Number(btn.dataset.id))
          .eq("status", "pending");
        if (error) return notice(error.message, "error");
        notice("Request cancelled", "success");
        await Promise.all([loadEvents(), loadRequests()]);
      });
    });
  } catch (err) {
    console.error("requests load failed:", err);
    body.innerHTML = `<tr><td colspan="7" class="muted small" style="text-align:center;padding:16px;color:#c00">${escapeHtml(err.message || "Could not load requests")}</td></tr>`;
  }
}

/* ---------------------------------------------------------------- init */

loadEvents();
loadRequests();
