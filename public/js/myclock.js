// PTL Timesheet — My Clock page.
// Shows the signed-in employee's own clock events (via the
// list_my_clock_events RPC — clock_events RLS is admin-only) and lets
// them request a time fix on flagged shifts: auto-closed ones and
// short ones (raw span under the org standard). Requests land in the
// Adjustments sub-tab of the Clock page where a clock viewer / admin
// approves or declines them (migration 146).

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

// Org standard shift length — the same app_settings value the Clock
// page's flag views use. Read best-effort: staff RLS may hide the row,
// in which case we fall back to the reviewer side's 8.5h default.
let clockStandardHours = null;
async function loadClockStandard() {
  if (clockStandardHours != null) return;
  try {
    const { data } = await sb.from("app_settings")
      .select("auto_close_shift_hours")
      .eq("organisation_id", employee.organisation_id).maybeSingle();
    clockStandardHours = Number(data?.auto_close_shift_hours) || 8.5;
  } catch {
    clockStandardHours = 8.5;
  }
}

// One row per SPELL, grouped by day, with In and Out columns:
//   * Shift rows pair the day's clock in/out events (a missing side shows
//     "—", so a never-clocked day reads In — / Out —).
//   * Break / off-site-job rows come from status_events (migration 147):
//     Out = when they left site, In = when they scanned back in.
// Every day of the selected week gets at least one row.
async function loadEvents() {
  const body = document.getElementById("mc-events-body");
  try {
    // Local-midnight week bounds as timestamptz — the RPCs compare
    // against occurred_at directly, so no timezone drift.
    const start = new Date(weekStart); start.setHours(0, 0, 0, 0);
    const end = addDays(start, 7);
    const bounds = { p_start: start.toISOString(), p_end_excl: end.toISOString() };
    const [evRes, spellRes] = await Promise.all([
      sb.rpc("list_my_clock_events", bounds),
      sb.rpc("list_my_offsite_spells", bounds),
      loadClockStandard(),
    ]);
    if (evRes.error) throw evRes.error;
    const events = evRes.data || [];
    // Spells are best-effort: if migration 147 isn't applied yet the
    // page still works, just without break/off-site rows.
    if (spellRes.error) console.warn("list_my_offsite_spells unavailable:", spellRes.error.message);
    const spells = spellRes.error ? [] : (spellRes.data || []);

    const rowsByDay = new Map();
    const dayPush = (iso, row) => {
      const key = fmtDate(new Date(iso));
      if (!rowsByDay.has(key)) rowsByDay.set(key, []);
      rowsByDay.get(key).push(row);
    };

    // Pair the chronological in/out stream into shift rows.
    let openIn = null;
    const pushShift = (inEv, outEv) => {
      const anchor = inEv?.occurred_at || outEv?.occurred_at;
      dayPush(anchor, { kind: "shift", inEv, outEv, t: anchor });
    };
    for (const ev of events) {
      if (ev.event_type === "in") {
        if (openIn) pushShift(openIn, null); // in without an out (still on site / forgot)
        openIn = ev;
      } else {
        pushShift(openIn, ev); // out without an in shows In as "—"
        openIn = null;
      }
    }
    if (openIn) pushShift(openIn, null);

    for (const s of spells) {
      dayPush(s.started_at, { kind: s.kind, spell: s, t: s.started_at });
    }

    // One adjustable time cell: the time plus a request-fix affordance
    // (or the pending marker). Fix buttons only show on FLAGGED rows —
    // showFix is passed per row, and a flagged row offers Fix on both its
    // In and Out cells so whichever side is wrong can be requested. Every
    // recorded event cell is also double-clickable to open the same
    // request dialog, flag or not (data attrs + delegated listener below
    // the table render).
    //
    // `target` decides which RPC the dialog submits to: shift rows carry
    // clock_events ids, spell rows carry status_events ids, and the two
    // are different tables with different submit functions. `label` is
    // only used to word the dialog.
    //
    // A null id means there is nothing to adjust — either the event was
    // never recorded (no clock-out, no scan back in), or migration 171
    // isn't applied yet and the spell RPC returned no ids. Both degrade
    // to a plain display cell rather than a broken affordance.
    const adjCell = ({ id, type, time, pendingId, showFix, target, label }) => {
      if (!time) return `<td class="num muted">—</td>`;
      const t = escapeHtml(fmtEventTime(time));
      const sort = ` data-sort-value="${escapeHtml(time)}"`;
      if (pendingId) {
        return `<td class="num"${sort}>${t} <span class="small muted">(requested)</span></td>`;
      }
      if (!id) return `<td class="num"${sort}>${t}</td>`;
      const attrs = `data-event-id="${id}" data-type="${type}" data-time="${escapeHtml(time)}" data-target="${target}" data-label="${escapeHtml(label || "")}"`;
      const fix = showFix
        ? ` <button class="ghost small mc-request-btn" ${attrs} title="Request a time fix">Fix</button>`
        : "";
      return `<td class="num mc-adjustable" ${attrs} title="Double-click to request a time fix"${sort}>${t}${fix}</td>`;
    };

    const evCell = (ev, showFix) => {
      if (!ev) return `<td class="num muted">—</td>`;
      return adjCell({
        id: ev.pending_request_id ? null : ev.id,
        type: ev.event_type,
        time: ev.occurred_at,
        pendingId: ev.pending_request_id,
        showFix,
        target: "clock",
        label: "Shift",
      });
    };

    const html = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(start, i);
      const key = fmtDate(d);
      const dayLabel = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
      const dayCell = `<td class="small" data-sort-value="${key}">${escapeHtml(dayLabel)}</td>`;
      const rows = (rowsByDay.get(key) || []).sort((a, b) => new Date(a.t) - new Date(b.t));
      if (!rows.length) {
        // Weekends aren't expected workdays, so an empty Sat/Sun isn't
        // flagged as "Not clocked in" — it just shows a neutral dash.
        const isWeekend = i >= 5;
        html.push(`<tr>${dayCell}<td class="small muted">${isWeekend ? "—" : "Not clocked in"}</td><td class="num muted">—</td><td class="num muted">—</td><td></td></tr>`);
        continue;
      }
      for (const r of rows) {
        if (r.kind === "shift") {
          // A shift offers Fix when auto-closed OR short: completed with
          // a raw in→out span under the org standard. Raw (not
          // break-adjusted) is fine here — it only decides whether the
          // request affordance shows, and a raw-short shift is always
          // worked-short too.
          const rawH = (r.inEv && r.outEv)
            ? (new Date(r.outEv.occurred_at) - new Date(r.inEv.occurred_at)) / 3600000
            : null;
          const isShort = rawH != null && rawH > 0 && rawH < clockStandardHours;
          const autoClosed = !!r.outEv?.auto_closed;
          const flagged = autoClosed || isShort;
          const flags = autoClosed
            ? `<span class="cvt-cell cvt-warn" style="padding:2px 8px;border-radius:999px;display:inline-block">Auto-closed</span>`
            : isShort
            ? `<span class="cvt-cell cvt-danger" style="padding:2px 8px;border-radius:999px;display:inline-block">Short shift</span>`
            : "";
          html.push(`<tr>${dayCell}
            <td><span class="tc-live-pill onsite">Shift</span></td>
            ${evCell(r.inEv, flagged)}${evCell(r.outEv, flagged)}
            <td>${flags}</td></tr>`);
        } else {
          // Both sides of a spell are adjustable, and they are SEPARATE
          // status_events rows: leaving site is the Out, scanning back in
          // is the In. A spell with no return has no second row, so that
          // cell stays a plain dash — same as a missing clock-out.
          const s = r.spell;
          const label = r.kind === "break"
            ? `Break${s.break_name ? ` (${escapeHtml(s.break_name)})` : ""}`
            : "Off-site job";
          const plain = r.kind === "break" ? "Break" : "Off-site job";
          const pillCls = r.kind === "break" ? "break" : "offsite";
          html.push(`<tr>${dayCell}
            <td><span class="tc-live-pill ${pillCls}">${label}</span></td>
            ${adjCell({
              id: s.return_event_id, type: "in", time: s.returned_at,
              pendingId: s.return_pending_request_id,
              target: "offsite", label: plain,
            })}
            ${adjCell({
              id: s.start_event_id, type: "out", time: s.started_at,
              pendingId: s.start_pending_request_id,
              target: "offsite", label: plain,
            })}
            <td>${!s.returned_at ? `<span class="small muted">no scan back in</span>` : ""}</td></tr>`);
        }
      }
    }
    body.innerHTML = html.join("");

    body.querySelectorAll(".mc-request-btn").forEach((btn) => {
      btn.addEventListener("click", () => openAdjustDialog({
        eventId: Number(btn.dataset.eventId),
        type:    btn.dataset.type,
        time:    btn.dataset.time,
        target:  btn.dataset.target,
        label:   btn.dataset.label,
      }));
    });
  } catch (err) {
    console.error("clock events load failed:", err);
    body.innerHTML = `<tr><td colspan="5" class="muted small" style="text-align:center;padding:16px;color:#c00">${escapeHtml(err.message || "Could not load clock events")}</td></tr>`;
  }
}

// Double-click any recorded event cell to request a fix — works on
// unflagged shifts and on both sides of a break / off-site spell.
// Delegated once; cells carry the event data. Cells with a pending
// request don't get the data attrs, so they're naturally inert here.
document.getElementById("mc-events-body").addEventListener("dblclick", (e) => {
  const td = e.target.closest("td[data-event-id]");
  if (!td || e.target.closest(".mc-request-btn")) return;
  openAdjustDialog({
    eventId: Number(td.dataset.eventId),
    type:    td.dataset.type,
    time:    td.dataset.time,
    target:  td.dataset.target,
    label:   td.dataset.label,
  });
});

/* ---------------------------------------------------------------- request dialog */

let dialogEventId = null;
let dialogTarget = "clock";

function openAdjustDialog({ eventId, type, time, target, label }) {
  dialogEventId = eventId;
  dialogTarget = target === "offsite" ? "offsite" : "clock";
  // "Clock in / clock out" is the wrong vocabulary for a spell — nobody
  // clocks out to take a break, they scan away and scan back.
  const what = dialogTarget === "offsite"
    ? (type === "in"
        ? `Scanned back in from ${label || "off site"}`
        : `Left site for ${label || "off site"}`)
    : `Clock ${type === "in" ? "in" : "out"} recorded`;
  document.getElementById("mc-adjust-summary").textContent =
    `${what} at ${fmtEventDay(time)} ${fmtEventTime(time)}. Enter what the time should have been.`;
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
    // Two tables, two functions. Deliberately NOT one function with an
    // optional second id: adding a defaulted parameter to the existing
    // submit_clock_adjustment would create an overload rather than
    // replace it, and PostgREST could no longer dispatch by name.
    const reason = document.getElementById("mc-adjust-reason").value.trim() || null;
    const { error } = dialogTarget === "offsite"
      ? await sb.rpc("submit_offsite_adjustment", {
          p_status_event_id: dialogEventId,
          p_requested_time: requested.toISOString(),
          p_reason: reason,
        })
      : await sb.rpc("submit_clock_adjustment", {
          p_clock_event_id: dialogEventId,
          p_requested_time: requested.toISOString(),
          p_reason: reason,
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

const REQUEST_COLS = "id, event_type, original_time, requested_time, reason, status, review_note, created_at";

async function loadRequests() {
  const body = document.getElementById("mc-requests-body");
  try {
    const fetchRequests = (cols) => sb
      .from("clock_adjustment_requests")
      .select(cols)
      .eq("user_id", employee.id)
      .order("created_at", { ascending: false })
      .limit(50);

    // status_event_id only exists once migration 171 is applied. Asking
    // for a column that isn't there is a hard PostgREST error, not an
    // empty value, so it would take the whole list down — retry without
    // it instead, exactly as the spells RPC degrades above.
    let { data, error } = await fetchRequests(`${REQUEST_COLS}, status_event_id`);
    if (error && /status_event_id/.test(error.message || "")) {
      ({ data, error } = await fetchRequests(REQUEST_COLS));
    }
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
      // Without the kind, a shift In and a break In on the same day are
      // two identical-looking rows.
      const kind = r.status_event_id ? "Off-site" : "Shift";
      return `<tr>
        <td class="small">${escapeHtml(fmtEventDay(r.original_time))} · ${kind} ${r.event_type === "in" ? "in" : "out"}</td>
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
