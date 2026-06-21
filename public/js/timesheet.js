// PTL Timesheet — My Timesheets hub + weekly grid editor.

import { getSupabase } from "/js/supabase-client.js";
import {
  notice, escapeHtml, renderTopbar, getUserContext,
  DAYS, getMonday, fmtDate, fmtShortDate, addDays,
  TS_STATUS, isTsSubmittedOrApproved,
  confirmDialog,
  invalidateWeekDashboard,
  getActiveMonday,
  isUserEffectiveOverhead,
} from "/js/shared.js";

const sb = await getSupabase();

/* ---------------------------------------------------------------- auth */

const { data: { session } } = await sb.auth.getSession();
if (!session) { location.replace("/signin.html"); throw new Error("not signed in"); }

const ctx = await getUserContext(sb, session);
const { isDeveloper, adminRow, isManager, isClockViewer } = ctx;
let employee = ctx.employee;

// ---------------------------------------------------------------- admin mode
// When an admin opens timesheet.html?user=<id>&week=<date>&admin=1 (linked
// from the timesheet-view "Edit (admin)" button), override `employee` with
// the target user's record so the rest of the page edits their timesheet
// instead of the caller's. RLS allows admin updates via the
// `admins manage org timesheets` / `admins manage org entries` policies.
const _adminParams = new URLSearchParams(location.search);
const ADMIN_MODE = _adminParams.get("admin") === "1" && !!_adminParams.get("user");
const ADMIN_RETURN = decodeURIComponent(_adminParams.get("return") || "") || "/admin.html#tab=infusion";
const ADMIN_TARGET_USER_ID = ADMIN_MODE ? Number(_adminParams.get("user")) : null;
const ADMIN_TARGET_WEEK = ADMIN_MODE ? _adminParams.get("week") : null;

// In ADMIN_MODE: admins always allowed; managers allowed if they manage
// the target user (validated via the user_manages_target_user RPC).
// IS_MANAGER_OVERRIDE governs which RPC is called to materialise the
// timesheet row downstream.
let IS_MANAGER_OVERRIDE = false;

if (ADMIN_MODE) {
  const isAdminOrDev = isDeveloper || adminRow?.role === "admin";
  if (!isAdminOrDev) {
    if (isManager) {
      const { data: managesTarget } = await sb.rpc("user_manages_target_user", { p_user_id: ADMIN_TARGET_USER_ID });
      if (managesTarget !== true) {
        location.replace("/timesheet.html");
        throw new Error("manager does not manage target user");
      }
      IS_MANAGER_OVERRIDE = true;
    } else {
      location.replace("/timesheet.html");
      throw new Error("admin mode requires admin or manager role");
    }
  }
  const { data: target, error: targetErr } = await sb
    .from("users")
    .select("id, name, organisation_id, department_id, auth_user_id, employment_type")
    .eq("id", ADMIN_TARGET_USER_ID)
    .maybeSingle();
  if (targetErr || !target) {
    notice("Couldn't load target employee", "error", { sticky: true });
    throw new Error("admin target user not found");
  }
  employee = target;
}

if (!employee) {
  // The cached user context may be stale — e.g. the user signed in
  // before their employee row existed, an admin then added them, and
  // the 5-minute sessionStorage cache is still serving "no employee".
  // Force one fresh fetch before sending them to welcome.html;
  // otherwise welcome bounces them straight back here on its own
  // fresh query and we loop. If the live fetch still finds nothing
  // they're genuinely unlinked, fall through to welcome as before.
  const freshCtx = await getUserContext(sb, session, { force: true });
  if (freshCtx?.employee) {
    employee = freshCtx.employee;
  } else {
    location.replace("/welcome.html");
    throw new Error("no employee record");
  }
}

const currentOrgId = employee.organisation_id;

let isOverhead = false;
let requireTask = false;

// Fire org-scoped fetches in parallel; render the topbar immediately so the
// page is visible while they resolve. Consumers below await each promise
// just before they read its data.
const deptInfoPromise = (async () => {
  if (!employee.department_id) return { isOverhead: false, requireTask: false };
  try {
    const { data } = await sb
      .from("departments")
      .select("is_overhead, require_task")
      .eq("id", employee.department_id)
      .maybeSingle();
    // Specific-rate employees in an overhead department still submit
    // timesheets — see isUserEffectiveOverhead in shared.js.
    const isOverhead = isUserEffectiveOverhead(employee, data);
    return { isOverhead, requireTask: !!data?.require_task };
  } catch (err) {
    console.warn("department lookup failed:", err);
    return { isOverhead: false, requireTask: false };
  }
})();

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
  active: "timesheet",
});

/* ---------------------------------------------------------------- state */

const DAY_NAMES = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
let weekStart = null;
let timesheetId = null;
let tsStatus = "draft";
let tsSubmittedAt = null;
let entries = [];
let jobs = [];
let tasks = [];
let deptCodes = [];
let jobsById = new Map();
let tasksById = new Map();
let deptCodesById = new Map();
// Autocomplete-ready item lists derived from jobs/tasks/deptCodes; rebuilt
// in loadLookups, not on every renderGrid pass.
let jobItems = [];
let deptItems = [];
let taskItems = [];
let holidays = {};
let calMonth = new Date();
let orgDeadline = { week: "following_week", day: "monday", time: "08:00" };
let orgAutofillPH = false;
let orgPHHours = 8;
let orgPHJobId = null;
let orgEmpTypeSettings = null;
// Map leave-type id → entitlement flag key ('annual_leave' | 'sick_leave' | 'public_holidays').
// Built from public.leave_types.code. Anything outside ANNUAL / SICK /
// PUBLIC_HOLIDAY is left out — those types aren't gated by the per-staff-type
// toggles, so picking them never warns.
let leaveTypeFlagById = new Map();
const LEAVE_CODE_TO_FLAG = {
  ANNUAL: "annual_leave",
  SICK: "sick_leave",
  PUBLIC_HOLIDAY: "public_holidays",
};
const FLAG_LABEL = {
  annual_leave: "annual leave",
  sick_leave: "sick leave",
  public_holidays: "public holidays",
};
const TYPE_LABEL = {
  waged: "waged",
  salaried: "salaried",
  contractor: "a contractor",
};

function weekLabel() {
  const end = addDays(weekStart, 6);
  const opts = { day: "numeric", month: "short" };
  const startYear = weekStart.getFullYear();
  const endYear = end.getFullYear();
  if (startYear === endYear) {
    return `${weekStart.toLocaleDateString(undefined, opts)} — ${end.toLocaleDateString(undefined, opts)}, ${endYear}`;
  }
  // Week straddles a year boundary (e.g. 30 Dec 2025 — 5 Jan 2026). Show
  // both years so it isn't read as a single year.
  const optsWithYear = { day: "numeric", month: "short", year: "numeric" };
  return `${weekStart.toLocaleDateString(undefined, optsWithYear)} — ${end.toLocaleDateString(undefined, optsWithYear)}`;
}

// "Active" week the UI focuses on: Mondays still show last week so the
// previous week stays editable / reviewable for one extra day.
const thisMonday = getActiveMonday();

const loadedHolidayYears = new Set();
const holidayYearLoads = new Map();

async function loadHolidaysForYear(year) {
  if (loadedHolidayYears.has(year)) return;
  if (holidayYearLoads.has(year)) return holidayYearLoads.get(year);
  const p = (async () => {
    const { data, error } = await sb
      .from("public_holidays")
      .select("holiday_date, name")
      .eq("organisation_id", currentOrgId)
      .gte("holiday_date", `${year - 1}-01-01`)
      .lte("holiday_date", `${year + 1}-12-31`);
    if (error) {
      console.warn("holidays load failed:", error);
      notice("Couldn't load public holidays — calendar marks may be missing", "warn");
      return;
    }
    for (const h of data || []) holidays[h.holiday_date] = h.name;
    loadedHolidayYears.add(year - 1);
    loadedHolidayYears.add(year);
    loadedHolidayYears.add(year + 1);
  })();
  holidayYearLoads.set(year, p);
  try { await p; } finally { holidayYearLoads.delete(year); }
}

function ensureHolidaysForCalMonth() {
  return loadHolidaysForYear(calMonth.getFullYear());
}

const holidaysPromise = loadHolidaysForYear(new Date().getFullYear());
const orgDeadlinePromise = loadOrgDeadline();
let lookupsPromise = null;
function ensureLookups() { return (lookupsPromise ||= loadLookups()); }

/* ---------------------------------------------------------------- views */

function showHub() {
  document.getElementById("hub-view").style.display = "";
  document.getElementById("editor-view").style.display = "none";
  document.querySelector(".container").classList.remove("ts-container");
  loadCurrentWeekCard();
  // Leave-request widgets are dormant — code kept for future re-enable.
  // loadLeaveBalances();
  // loadMyLeaveRequests();
  renderCalendar();
}

let leaveTypes = [];
let leaveJobs = [];

async function loadLeaveJobs() {
  if (leaveJobs.length) return leaveJobs;
  const { data } = await sb
    .from("jobs")
    .select("id, job_code, description, leave_type_id")
    .eq("organisation_id", currentOrgId)
    .eq("is_leave", true)
    .order("job_code");
  leaveJobs = data || [];
  return leaveJobs;
}

async function loadLeaveBalances() {
  const card = document.getElementById("leave-balance-card");
  const body = document.getElementById("leave-balance-body");
  if (!employee?.id) return;

  // Always load leave types (for the request dialog)
  const { data: types } = await sb
    .from("leave_types")
    .select("id, name, code, unit, sort_order, active")
    .eq("organisation_id", currentOrgId)
    .eq("active", true)
    .order("sort_order");
  leaveTypes = types || [];

  const { data, error } = await sb
    .from("leave_balances")
    .select("balance, used_total, leave_types(name, unit, sort_order)")
    .eq("user_id", employee.id);

  if (leaveTypes.length && (!data || !data.length)) {
    // No balances seeded yet — still show the card so user can request leave
    card.style.display = "";
    body.innerHTML = `<div class="muted small" style="padding:8px">No balances yet. Contact admin to set up entitlements.</div>`;
    return;
  }

  if (error || !data?.length) {
    card.style.display = "none";
    return;
  }

  const rows = data
    .filter((r) => r.leave_types)
    .sort((a, b) => (a.leave_types.sort_order || 0) - (b.leave_types.sort_order || 0));

  card.style.display = "";
  body.innerHTML = rows.map((r) => `
    <div class="leave-balance-tile">
      <div class="lb-name">${escapeHtml(r.leave_types.name)}</div>
      <div class="lb-value">${Number(r.balance).toFixed(r.leave_types.unit === "days" ? 1 : 2)}<span class="lb-unit">${r.leave_types.unit === "days" ? "days" : "hrs"}</span></div>
      <div class="lb-used">${Number(r.used_total).toFixed(1)} used</div>
    </div>
  `).join("");
}

async function loadMyLeaveRequests() {
  const card = document.getElementById("my-leave-requests-card");
  const body = document.getElementById("my-leave-requests-body");
  if (!employee?.id) return;

  const { data } = await sb
    .from("leave_requests")
    .select("id, start_date, end_date, hours_per_day, status, reason, leave_type_id, leave_types(name)")
    .eq("user_id", employee.id)
    .order("created_at", { ascending: false })
    .limit(20);

  if (!data?.length) {
    card.style.display = "none";
    return;
  }

  card.style.display = "";
  body.innerHTML = data.map((r) => {
    const statusClass = r.status === "approved" ? "chip-submitted" :
                        r.status === "rejected" ? "chip-pending" :
                        "chip-pending";
    const canCancel = r.status === "pending";
    const dateRange = r.start_date === r.end_date
      ? r.start_date
      : `${r.start_date} → ${r.end_date}`;
    return `<tr data-id="${r.id}">
      <td>${escapeHtml(r.leave_types?.name || "")}</td>
      <td class="small">${dateRange}</td>
      <td class="num">${r.hours_per_day}</td>
      <td><span class="chip-dash ${statusClass}">${r.status}</span></td>
      <td class="small muted">${escapeHtml(r.reason || "")}</td>
      <td>${canCancel ? `<button class="ghost small cancel-lr-btn">Cancel</button>` : ""}</td>
    </tr>`;
  }).join("");

  body.querySelectorAll(".cancel-lr-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.closest("tr").dataset.id);
      if (!await confirmDialog({ title: "Cancel leave request", message: "Cancel this leave request?", confirmText: "Cancel request", danger: true })) return;
      const { error } = await sb.from("leave_requests")
        .update({ status: "cancelled" }).eq("id", id);
      if (error) return notice(error.message, "error");
      notice("Request cancelled", "success");
      await loadMyLeaveRequests();
    });
  });
}

document.getElementById("request-leave-btn")?.addEventListener("click", async () => {
  await loadLeaveJobs();
  const dialog = document.getElementById("leave-request-dialog");
  const sel = document.getElementById("lr-type");
  sel.innerHTML = leaveJobs
    .filter((j) => j.leave_type_id)
    .map((j) =>
      `<option value="${j.leave_type_id}">${escapeHtml(j.job_code)}${j.description ? " — " + escapeHtml(j.description) : ""}</option>`
    ).join("");
  document.getElementById("lr-start").value = "";
  document.getElementById("lr-end").value = "";
  document.getElementById("lr-hours").value = "8";
  document.getElementById("lr-reason").value = "";
  document.getElementById("lr-skip-weekends").checked = true;
  dialog.showModal();
});

document.getElementById("lr-cancel")?.addEventListener("click", () => {
  document.getElementById("leave-request-dialog").close();
});

document.getElementById("leave-request-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const leaveTypeId = Number(document.getElementById("lr-type").value);
  const startDate = document.getElementById("lr-start").value;
  const endDate = document.getElementById("lr-end").value;
  const hours = Number(document.getElementById("lr-hours").value);
  const skipWeekends = document.getElementById("lr-skip-weekends").checked;
  const reason = document.getElementById("lr-reason").value.trim() || null;

  if (!Number.isFinite(leaveTypeId) || leaveTypeId <= 0) return notice("Pick a leave type", "warn");
  if (!startDate || !endDate) return notice("Pick start and end dates", "warn");
  if (new Date(endDate) < new Date(startDate)) return notice("End date must be after start date", "warn");
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) return notice("Hours per day must be between 0 and 24", "warn");

  const { error } = await sb.from("leave_requests").insert({
    organisation_id: currentOrgId,
    user_id: employee.id,
    leave_type_id: leaveTypeId,
    start_date: startDate,
    end_date: endDate,
    hours_per_day: hours,
    skip_weekends: skipWeekends,
    reason,
    status: "pending",
  });
  if (error) return notice(error.message, "error");

  document.getElementById("leave-request-dialog").close();
  notice("Leave request submitted", "success");
  if (isOverhead) {
    await loadOverheadLeaveRequests();
  } else {
    await loadMyLeaveRequests();
  }
});

function showEditor(ws) {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  weekStart = ws;
  document.getElementById("hub-view").style.display = "none";
  document.getElementById("editor-view").style.display = "";
  document.querySelector(".container").classList.add("ts-container");
  loadWeek();
}

document.getElementById("back-to-hub").addEventListener("click", () => {
  if (ADMIN_MODE) { location.href = ADMIN_RETURN; return; }
  showHub();
});

/* ---------------------------------------------------------------- current week card */

// Computes the deadline for the CURRENT week off the module-level
// `thisMonday` constant. Not a generic "deadline for any week" helper —
// don't call it from non-current-week code paths or you'll get the
// wrong answer. Renaming to keep that obvious to future readers.
function getCurrentWeekDeadline() {
  let targetDayIdx = DAY_NAMES.indexOf(orgDeadline.day);
  if (targetDayIdx === -1) targetDayIdx = 1; // fall back to Monday on bad config

  const [rawH, rawM] = (orgDeadline.time || "08:00").split(":").map(Number);
  const hh = Number.isInteger(rawH) && rawH >= 0 && rawH <= 23 ? rawH : 8;
  const mm = Number.isInteger(rawM) && rawM >= 0 && rawM <= 59 ? rawM : 0;

  let base;
  if (orgDeadline.week === "this_week") {
    base = new Date(thisMonday);
  } else {
    base = addDays(thisMonday, 7);
  }

  // base is a Monday; offset to the target day (Mon=1 in JS getDay)
  const monIdx = 1;
  let dayOffset = targetDayIdx - monIdx;
  if (dayOffset < 0) dayOffset += 7;
  const deadline = addDays(base, dayOffset);
  deadline.setHours(hh, mm, 0, 0);
  return deadline;
}

function formatCountdown(ms) {
  if (ms <= 0) return "Overdue";
  const totalSecs = Math.floor(ms / 1000);
  const days = Math.floor(totalSecs / 86400);
  const hours = Math.floor((totalSecs % 86400) / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  return `${mins}m ${secs}s`;
}

let countdownInterval = null;

async function loadCurrentWeekCard() {
  const card = document.getElementById("current-week-card");
  const body = document.getElementById("current-week-body");
  const ws = fmtDate(thisMonday);
  const end = addDays(thisMonday, 6);
  const weekStr = `${thisMonday.toLocaleDateString(undefined, { day: "numeric", month: "short" })} — ${end.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;

  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }

  try {
    // Run the timesheet lookup in parallel with the org-deadline fetch; both
    // are needed before rendering the countdown.
    const [{ data: ts }] = await Promise.all([
      sb.from("timesheets")
        .select("id, status")
        .eq("user_id", employee.id)
        .eq("week_start", ws)
        .maybeSingle(),
      orgDeadlinePromise,
    ]);

    let totalHours = 0;
    let taskCount = 0;
    if (ts) {
      const { data: ents } = await sb
        .from("timesheet_entries")
        .select("mon_hours, tue_hours, wed_hours, thu_hours, fri_hours, sat_hours, sun_hours")
        .eq("timesheet_id", ts.id);
      taskCount = ents?.length || 0;
      for (const e of ents || []) {
        totalHours += DAYS.reduce((s, d) => s + (Number(e[`${d}_hours`]) || 0), 0);
      }
    }

    const TARGET = 40;
    const pct = Math.min(100, Math.round((totalHours / TARGET) * 100));

    card.classList.remove("submitted", "draft", "rejected");

    if (isTsSubmittedOrApproved(ts?.status)) {
      card.classList.add("submitted");
      body.innerHTML = `
        <p style="margin:0"><strong>${weekStr}</strong></p>
        <p style="font-size:18px;margin:8px 0 0;color:#5a7a00">Timesheet submitted</p>
        <div class="ts-progress-bar mt-sm">
          <div class="ts-progress-fill submitted" style="width:${pct}%"></div>
        </div>
        <p class="muted small" style="margin:6px 0 0">
          ${totalHours}h logged across ${taskCount} task${taskCount !== 1 ? "s" : ""}
          · <a href="#" id="view-current">View timesheet →</a>
        </p>
      `;
    } else if (ts?.status === TS_STATUS.REJECTED) {
      // Same visual shape as submitted but red - tells the employee
      // there's something they need to fix and resubmit.
      card.classList.add("rejected");
      body.innerHTML = `
        <p style="margin:0"><strong>${weekStr}</strong></p>
        <p style="font-size:18px;margin:8px 0 0;color:var(--danger);font-weight:600">
          Timesheet rejected
        </p>
        <p class="muted small" style="margin:6px 0 0">
          Your manager sent this timesheet back. Update the entries and resubmit.
        </p>
        <div class="ts-progress-bar mt-sm">
          <div class="ts-progress-fill rejected" style="width:${pct}%"></div>
        </div>
        <div class="row-flex mt-sm" style="gap:16px">
          <span>${totalHours} / ${TARGET}h</span>
          <span class="muted small">${taskCount} task${taskCount !== 1 ? "s" : ""}</span>
        </div>
        <p style="margin:12px 0 0">
          <button id="edit-current" class="primary">Edit and resubmit →</button>
        </p>
      `;
    } else {
      card.classList.add("draft");
      const deadline = getCurrentWeekDeadline();
      const urgencyClass = (deadline - Date.now()) < 24 * 60 * 60 * 1000 ? "urgent" : "";
      body.innerHTML = `
        <p style="margin:0"><strong>${weekStr}</strong></p>
        <div class="ts-progress-bar mt-sm">
          <div class="ts-progress-fill" style="width:${pct}%"></div>
        </div>
        <div class="row-flex mt-sm" style="gap:16px">
          <span>${totalHours} / ${TARGET}h</span>
          <span class="muted small">${taskCount} task${taskCount !== 1 ? "s" : ""}</span>
          <div class="grow"></div>
          <span class="ts-countdown ${urgencyClass}" id="countdown"></span>
        </div>
        <p style="margin:12px 0 0">
          <button id="edit-current" class="primary">Open this week's timesheet →</button>
        </p>
      `;

      // Start countdown
      const countdownEl = document.getElementById("countdown");
      function tick() {
        const remaining = deadline - Date.now();
        const urgency = remaining < 24 * 60 * 60 * 1000;
        countdownEl.textContent = `Due in ${formatCountdown(remaining)}`;
        countdownEl.classList.toggle("urgent", urgency);
      }
      tick();
      countdownInterval = setInterval(tick, 1000);
    }

    document.getElementById("view-current")?.addEventListener("click", (e) => {
      e.preventDefault(); showEditor(thisMonday);
    });
    document.getElementById("edit-current")?.addEventListener("click", (e) => {
      e.preventDefault(); showEditor(thisMonday);
    });
  } catch (err) {
    body.innerHTML = `<p class="muted">Failed to load current week</p>`;
  }
}

/* ---------------------------------------------------------------- week calendar */

// Per-month cache for the calendar tile data. Invalidated on submit/edit.
const calCache = new Map();
const CAL_TTL_MS = 60_000;
function invalidateCalCache() { calCache.clear(); }

async function fetchCalendarMonth(start, end) {
  const tsMap = {};
  const { data } = await sb
    .from("timesheets")
    .select("week_start, status, id")
    .eq("user_id", employee.id)
    .gte("week_start", fmtDate(start))
    .lte("week_start", fmtDate(end));

  if (data?.length) {
    const ids = data.map((t) => t.id);
    const { data: entries } = await sb
      .from("timesheet_entries")
      .select("timesheet_id, mon_hours, tue_hours, wed_hours, thu_hours, fri_hours, sat_hours, sun_hours")
      .in("timesheet_id", ids);

    const totals = {};
    for (const e of entries || []) {
      const sum = DAYS.reduce((s, d) => s + (Number(e[`${d}_hours`]) || 0), 0);
      totals[e.timesheet_id] = (totals[e.timesheet_id] || 0) + sum;
    }
    for (const t of data) {
      tsMap[t.week_start] = { status: t.status, hours: totals[t.id] || 0 };
    }
  }
  return tsMap;
}

async function renderCalendar() {
  const label = document.getElementById("cal-month-label");
  const body = document.getElementById("cal-body");

  const year = calMonth.getFullYear();
  const month = calMonth.getMonth();
  label.textContent = calMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const first = new Date(year, month, 1);
  let start = getMonday(first);
  const end = new Date(year, month + 1, 7);

  const cacheKey = `${year}-${String(month).padStart(2, "0")}`;
  let tsMap;
  const cached = calCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CAL_TTL_MS) {
    tsMap = cached.tsMap;
    await ensureHolidaysForCalMonth();
  } else {
    try {
      // Fetch the month's timesheet data in parallel with the holidays load.
      const [data] = await Promise.all([fetchCalendarMonth(start, end), ensureHolidaysForCalMonth()]);
      tsMap = data;
      calCache.set(cacheKey, { tsMap, ts: Date.now() });
    } catch (err) {
      console.warn("calendar load failed:", err);
      tsMap = {};
    }
  }

  let rows = "";
  let weekDate = new Date(start);

  // Render up to 6 weekly rows (a month spans at most 6 calendar weeks). Using
  // a bounded counter avoids the December wrap bug where getMonth() <= month
  // (11) stays true after rolling into January (0).
  const todayWs = fmtDate(thisMonday);
  for (let wk = 0; wk < 6; wk++) {
    const mon = new Date(weekDate);
    const ws = fmtDate(mon);
    const isCurrent = ws === todayWs;
    const ts = tsMap[ws];

    const dayCells = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(mon, i);
      const dKey = fmtDate(d);
      const inMonth = d.getMonth() === month;
      const isWeekend = i >= 5;
      const holidayName = holidays[dKey];
      const isHoliday = !!holidayName;
      const cls = [
        inMonth ? "" : "muted",
        isWeekend ? "cal-weekend" : "",
        isHoliday ? "cal-holiday" : "",
      ].filter(Boolean).join(" ");
      const title = isHoliday ? ` title="${escapeHtml(holidayName)}"` : "";
      dayCells.push(`<td class="${cls}" style="${inMonth ? "" : "opacity:0.4"}"${title}>${d.getDate()}</td>`);
    }

    const statusBadge = ts
      ? `<span class="status-badge status-${ts.status}">${ts.status}</span>`
      : `<span class="muted small">—</span>`;
    const hours = ts ? `${ts.hours}h` : "";
    const action = ts
      ? `<a href="#" class="week-action" data-week="${ws}">View</a>`
      : `<a href="#" class="week-action" data-week="${ws}">Create</a>`;

    const rowClass = isCurrent ? "current-week" :
      isTsSubmittedOrApproved(ts?.status) ? "week-submitted" :
      ts?.status === TS_STATUS.REJECTED ? "week-rejected" :
      ts?.status === TS_STATUS.DRAFT ? "week-draft" : "";

    rows += `<tr class="week-row ${rowClass}" data-week="${ws}">
      ${dayCells.join("")}
      <td class="week-status">${statusBadge}</td>
      <td class="small">${hours}</td>
      <td>${action}</td>
    </tr>`;

    weekDate.setDate(weekDate.getDate() + 7);
    // Stop once the next week starts in a later month and we've already
    // covered the whole month (at least 4 weeks past the 1st).
    const pastMonth = weekDate.getFullYear() > year ||
      (weekDate.getFullYear() === year && weekDate.getMonth() > month);
    if (pastMonth && weekDate > addDays(first, 28)) break;
  }

  // Monthly total row
  const calMonthTotal = Object.values(tsMap).reduce((s, t) => s + (t.hours || 0), 0);
  const monthName = calMonth.toLocaleDateString(undefined, { month: "long" });
  rows += `<tr class="cal-total-row">
    <td colspan="7" style="text-align:right"><strong>${monthName} total</strong></td>
    <td></td>
    <td class="small"><strong>${calMonthTotal}h</strong></td>
    <td></td>
  </tr>`;

  body.innerHTML = rows;

  // Click handlers for week rows
  body.querySelectorAll(".week-row").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      const ws = row.dataset.week;
      showEditor(getMonday(new Date(ws + "T00:00:00")));
    });
  });
  body.querySelectorAll(".week-action").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      showEditor(getMonday(new Date(a.dataset.week + "T00:00:00")));
    });
  });
}

document.getElementById("cal-prev").addEventListener("click", () => {
  calMonth.setMonth(calMonth.getMonth() - 1);
  ensureHolidaysForCalMonth();
  renderCalendar();
});
document.getElementById("cal-next").addEventListener("click", () => {
  calMonth.setMonth(calMonth.getMonth() + 1);
  ensureHolidaysForCalMonth();
  renderCalendar();
});

/* ---------------------------------------------------------------- load jobs + tasks */

async function fetchAllPaged(table, selectCols, orderCol, extraFilter) {
  const PAGE = 1000;
  let all = [];
  let from = 0;
  while (true) {
    let q = sb.from(table)
      .select(selectCols)
      .eq("organisation_id", currentOrgId)
      .order(orderCol)
      .range(from, from + PAGE - 1);
    if (extraFilter) q = extraFilter(q);
    const { data, error } = await q;
    if (error) break;
    all = all.concat(data || []);
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function loadLookups() {
  // Load every status (not just ACTIVE) so historical timesheet entries
  // referencing archived tasks / dept-codes still render their codes.
  // Filter ACTIVE-only when building the autocomplete suggestion lists so
  // users can't pick archived ones for new rows.
  const [jobsResult, tasksResult, deptResult, leaveTypesResult] = await Promise.all([
    fetchAllPaged("jobs", "id, job_code, description, status, is_leave, leave_type_id", "job_code"),
    fetchAllPaged("tasks", "id, task_code, description, status", "task_code"),
    fetchAllPaged("department_codes", "id, code, description, status", "code"),
    sb.from("leave_types").select("id, code").eq("organisation_id", currentOrgId),
  ]);
  leaveTypeFlagById = new Map(
    (leaveTypesResult?.data || [])
      .map((lt) => [lt.id, LEAVE_CODE_TO_FLAG[lt.code]])
      .filter(([, flag]) => !!flag),
  );

  jobs = jobsResult;
  tasks = tasksResult;
  deptCodes = deptResult;
  jobsById = new Map(jobs.map((j) => [j.id, j]));
  tasksById = new Map(tasks.map((t) => [t.id, t]));
  deptCodesById = new Map(deptCodes.map((d) => [d.id, d]));
  // jobs already loaded all statuses; matching tasks/dept_codes lookup
  // policy now too. Autocomplete still only suggests ACTIVE tasks/codes
  // so archived ones can't be picked for new rows but still render their
  // codes on read-only historical entries.
  jobItems = jobs.map((j) => ({ ...j, _label: j.job_code, _desc: j.description || "" }));
  deptItems = deptCodes
    .filter((dc) => dc.status === "ACTIVE")
    .map((dc) => ({ ...dc, _label: dc.code, _desc: dc.description || "" }));
  taskItems = tasks
    .filter((t) => t.status === "ACTIVE")
    .map((t) => ({ ...t, _label: t.task_code, _desc: t.description || "" }));
}

/* ---------------------------------------------------------------- load timesheet (editor) */

async function loadWeek() {
  // The editor depends on jobs/tasks/dept codes (lookups), holidays, and the
  // org deadline settings. Hub navigation pre-warms these promises, so this
  // is usually a no-op by the time the user opens the editor.
  // Holidays are scoped to currentYear ± 1 at boot; if the user opens a
  // week in a different year (URL deep-link to an old archive or future
  // schedule), pull that year's holidays now so the date row marks them
  // and autofillPublicHolidays sees them.
  await Promise.all([
    ensureLookups(),
    holidaysPromise,
    orgDeadlinePromise,
    loadHolidaysForYear(weekStart.getFullYear()),
  ]);

  document.getElementById("week-label").textContent =
    ADMIN_MODE ? `${employee.name} · ${weekLabel()}` : weekLabel();
  if (ADMIN_MODE) document.title = `Admin edit — ${employee.name} · PTL Timesheet`;

  const dateRow = document.getElementById("date-row");
  dateRow.innerHTML = `<td colspan="5"></td>` +
    DAYS.map((_, i) => {
      const d = addDays(weekStart, i);
      const isWeekend = i >= 5;
      const hol = holidays[fmtDate(d)];
      const cls = [
        "day-col",
        isWeekend ? "day-weekend" : "",
        hol ? "day-holiday" : "",
      ].filter(Boolean).join(" ");
      const title = hol ? ` title="${escapeHtml(hol)}"` : "";
      return `<td class="${cls}"${title}>${fmtShortDate(d)}</td>`;
    }).join("") +
    `<td class="day-col"></td><td></td>`;

  try {
    if (ADMIN_MODE) {
      // get_or_create_timesheet keys on auth.uid(), so admins can't use
      // it to touch someone else's timesheet. Dedicated RPCs wrap the
      // same INSERT … ON CONFLICT pattern but take user_id explicitly
      // and gate on role — race-free, unlike a manual SELECT-then-INSERT.
      // Managers use a different RPC (migration 118) that checks dept
      // management rather than admin role.
      const fn = IS_MANAGER_OVERRIDE ? "manager_get_or_create_timesheet" : "admin_get_or_create_timesheet";
      const { data, error } = await sb.rpc(fn, {
        p_user_id: employee.id,
        p_week_start: fmtDate(weekStart),
      });
      if (error) throw error;
      timesheetId = data;
    } else {
      const { data, error } = await sb.rpc("get_or_create_timesheet", {
        p_week_start: fmtDate(weekStart),
      });
      if (error) throw error;
      timesheetId = data;
    }
  } catch (err) {
    console.error(err);
    notice(err.message || "Failed to load timesheet", "error");
    return;
  }

  // Status and entries don't depend on each other — fetch in parallel.
  const [statusRes, entriesRes] = await Promise.allSettled([
    sb.from("timesheets")
      .select("status, submitted_at, notes")
      .eq("id", timesheetId)
      .maybeSingle(),
    sb.from("timesheet_entries")
      .select("id, job_id, task_id, dept_code_id, description, sort_order, job_status_snapshot, mon_hours, tue_hours, wed_hours, thu_hours, fri_hours, sat_hours, sun_hours")
      .eq("timesheet_id", timesheetId)
      .order("sort_order")
      .order("id"),
  ]);

  if (statusRes.status === "fulfilled") {
    const data = statusRes.value?.data;
    tsStatus = data?.status || "draft";
    tsSubmittedAt = data?.submitted_at || null;
    renderStatusBadge();
    renderRejectionBanner(data?.notes);
  } else {
    console.warn("status badge refresh failed:", statusRes.reason);
  }

  if (entriesRes.status === "fulfilled" && !entriesRes.value?.error) {
    entries = entriesRes.value?.data || [];
  } else {
    const err = entriesRes.status === "fulfilled" ? entriesRes.value?.error : entriesRes.reason;
    console.error(err);
    notice(err?.message || "Failed to load entries", "error");
    entries = [];
  }

  // Auto-fill public holiday entries if setting is on and timesheet is draft
  if (orgAutofillPH && tsStatus === "draft") {
    await autofillPublicHolidays();
  }

  renderGrid();
}

/* ---------------------------------------------------------------- autocomplete helper */

function setupAC(input, items, { onSelect, onClear, requireQuery = false }) {
  const wrap = input.closest(".ac-wrap");
  const list = wrap.querySelector(".ac-list");
  let highlighted = -1;

  function render(query) {
    const q = (query || "").toLowerCase();
    let filtered;
    if (q) {
      // Rank: code starts-with > code contains > description contains. Within
      // each tier preserve the original (alphabetical) order. Enter picks
      // the top-ranked row, which is virtually always the user's intent.
      const tiers = [[], [], []];
      for (const it of items) {
        const label = it._label.toLowerCase();
        const desc = (it._desc || "").toLowerCase();
        if (label.startsWith(q)) tiers[0].push(it);
        else if (label.includes(q)) tiers[1].push(it);
        else if (desc.includes(q)) tiers[2].push(it);
      }
      filtered = tiers[0].concat(tiers[1], tiers[2]);
    } else {
      filtered = requireQuery ? [] : items;
    }
    const show = filtered.slice(0, 100);
    highlighted = show.length && q ? 0 : -1;
    list.innerHTML =
      show.map((it, i) =>
        `<div class="ac-item${i === highlighted ? " highlighted" : ""}" data-idx="${i}" data-id="${it.id}">
          <span>${escapeHtml(it._label)}</span>
          ${it._desc ? `<span class="ac-desc">${escapeHtml(it._desc)}</span>` : ""}
        </div>`
      ).join("") +
      `<div class="ac-clear" data-action="clear">(clear selection)</div>`;
    list.classList.add("open");
    list._items = show;
  }

  input.addEventListener("focus", () => { if (!requireQuery || input.value) render(input.value); });
  input.addEventListener("input", () => render(input.value));

  input.addEventListener("keydown", (e) => {
    const els = list.querySelectorAll(".ac-item");
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlighted = Math.min(highlighted + 1, els.length - 1);
      els.forEach((el, i) => el.classList.toggle("highlighted", i === highlighted));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlighted = Math.max(highlighted - 1, 0);
      els.forEach((el, i) => el.classList.toggle("highlighted", i === highlighted));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlighted >= 0 && list._items[highlighted]) pick(list._items[highlighted]);
    } else if (e.key === "Escape") {
      list.classList.remove("open");
    }
  });

  list.addEventListener("mousedown", (e) => {
    e.preventDefault();
    if (e.target.closest("[data-action='clear']")) {
      input.value = "";
      input.dataset.selectedId = "";
      list.classList.remove("open");
      if (onClear) onClear();
      return;
    }
    const item = e.target.closest(".ac-item");
    if (item && list._items) pick(list._items[Number(item.dataset.idx)]);
  });

  input.addEventListener("blur", () => setTimeout(() => list.classList.remove("open"), 150));

  function pick(it) {
    input.value = it._label;
    input.dataset.selectedId = String(it.id);
    list.classList.remove("open");
    if (onSelect) onSelect(it);
  }
}

/* ---------------------------------------------------------------- autofill public holidays */

// Returns false if the org's employment_type_settings explicitly disables
// the given flag for this employee's type. Missing settings / missing type
// → defaults to true (no restriction), which matches the seed defaults
// shipped in migration 050.
function employeeReceives(flagKey) {
  const type = employee?.employment_type;
  if (!type || !orgEmpTypeSettings) return true;
  const typeCfg = orgEmpTypeSettings[type];
  if (!typeCfg) return true;
  return typeCfg[flagKey] !== false;
}

// Warning toast when an entry is set to a leave job that the current
// employee's type isn't entitled to. Not a hard block — admins may still
// want to record an exception, and the org may revisit the setting.
function warnIfLeaveNotEntitled(job) {
  if (!job?.is_leave || !job.leave_type_id) return;
  const flagKey = leaveTypeFlagById.get(job.leave_type_id);
  if (!flagKey) return;
  if (employeeReceives(flagKey)) return;
  const typeLabel = TYPE_LABEL[employee?.employment_type] || employee?.employment_type || "this staff type";
  const flagLabel = FLAG_LABEL[flagKey];
  const msg = ADMIN_MODE
    ? `${employee?.name || "This employee"} is ${typeLabel} and does not receive ${flagLabel} — check before submitting.`
    : `You are ${typeLabel} and do not receive ${flagLabel} — check before submitting.`;
  notice(msg, "warn");
}

async function autofillPublicHolidays() {
  if (!timesheetId || !weekStart || !orgPHJobId) return;
  if (!employeeReceives("public_holidays")) return;

  const phJob = jobsById.get(orgPHJobId);
  if (!phJob) return;

  // Check which weekdays this week are holidays
  const phDays = [];
  for (let i = 0; i < 5; i++) {
    const d = addDays(weekStart, i);
    const key = fmtDate(d);
    if (holidays[key]) phDays.push({ idx: i, day: DAYS[i], name: holidays[key] });
  }
  if (!phDays.length) return;

  // Check if an entry for the PH job already exists
  const existing = entries.find((e) => e.job_id === phJob.id);
  if (existing) return;

  // Create the entry with hours on the holiday days
  const hoursCols = {};
  for (const d of DAYS) hoursCols[`${d}_hours`] = 0;
  for (const ph of phDays) hoursCols[`${ph.day}_hours`] = orgPHHours;

  const { data: newEntry, error } = await sb
    .from("timesheet_entries")
    .insert({
      timesheet_id: timesheetId,
      job_id: phJob.id,
      description: phDays.map((p) => p.name).join(", "),
      ...hoursCols,
    })
    .select()
    .maybeSingle();

  if (!error && newEntry) {
    entries.push(newEntry);
  }
}

/* ---------------------------------------------------------------- rejection banner */

// Surfaces the manager's rejection reason to the user. Without this the
// user sees a "Resubmit" button and a "Rejected" badge but no clue
// what to fix — they have to message the manager to ask.
function renderRejectionBanner(notes) {
  const banner = document.getElementById("rejection-banner");
  if (!banner) return;
  if (tsStatus === "rejected" && notes && notes.trim()) {
    document.getElementById("rejection-banner-note").textContent = notes.trim();
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

/* ---------------------------------------------------------------- status badge */

function renderStatusBadge() {
  const el = document.getElementById("ts-status");
  if (tsStatus === "draft" || !tsStatus) {
    el.className = "ts-status-badge ts-status-draft";
    el.innerHTML = `<span class="ts-status-dot draft"></span> Draft`;
    return;
  }
  const label = tsStatus.charAt(0).toUpperCase() + tsStatus.slice(1);
  let timeStr = "";
  if (tsSubmittedAt) {
    const d = new Date(tsSubmittedAt);
    const day = d.getDate();
    const mon = d.toLocaleString("en-NZ", { month: "short" });
    const yr = d.getFullYear();
    const time = d.toLocaleString("en-NZ", { hour: "numeric", minute: "2-digit", hour12: true });
    timeStr = `<span class="ts-status-time">Submitted ${day} ${mon} ${yr} at ${time}</span>`;
  }
  const dotClass = tsStatus === "approved"  ? "approved" :
                   tsStatus === "rejected"  ? "rejected" :
                   tsStatus === "exported"  ? "exported" :
                                              "submitted";
  el.className = `ts-status-badge ts-status-${dotClass}`;
  el.innerHTML = `<span class="ts-status-dot ${dotClass}"></span> ${label}${timeStr}`;
}

/* ---------------------------------------------------------------- render grid */

function renderGrid() {
  const body = document.getElementById("ts-body");
  // Admins editing on behalf of an employee bypass the status lock so they
  // can correct an already-submitted/approved timesheet.
  const isSubmitted = !ADMIN_MODE && isTsSubmittedOrApproved(tsStatus);

  // Show/hide submit bar based on status
  const submitBtn = document.getElementById("submit-ts-btn");
  const lockedMsg = document.getElementById("ts-locked-msg");
  if (ADMIN_MODE) {
    submitBtn.style.display = "none";
    lockedMsg.style.display = "";
    let msg = `Admin override — editing as ${employee.name}. Status (${tsStatus}) is not changed by your edits.`;
    if (tsStatus === TS_STATUS.EXPORTED) {
      msg = `⚠ This timesheet has already been EXPORTED to payroll. Changes here will NOT sync — fix the data in payroll separately, or use the dev "Revert exported → approved" button to re-export.`;
    }
    lockedMsg.textContent = msg;
  } else if (isSubmitted) {
    submitBtn.style.display = "none";
    lockedMsg.style.display = "";
    lockedMsg.textContent = `This timesheet has been ${tsStatus} and cannot be edited.`;
  } else {
    submitBtn.style.display = "";
    submitBtn.textContent = tsStatus === TS_STATUS.REJECTED
      ? "Resubmit Timesheet"
      : "Submit Timesheet";
    submitBtn.disabled = false;
    lockedMsg.style.display = "none";
  }

  // Disable editing controls when submitted/approved
  const addRowBtn = document.getElementById("add-row-btn");
  const importBtn = document.getElementById("import-last-week");
  if (addRowBtn) addRowBtn.style.display = isSubmitted ? "none" : "";
  if (importBtn) importBtn.style.display = isSubmitted || ADMIN_MODE ? "none" : "";

  if (!entries.length) {
    body.innerHTML = `<tr><td colspan="14" class="muted small" style="text-align:center;padding:24px">No tasks yet — click "+ Add task" below to start.</td></tr>`;
    updateTotals();
    return;
  }

  body.innerHTML = entries.map((e, idx) => rowHtml(e, idx, isSubmitted)).join("");

  if (!isSubmitted) {
    body.querySelectorAll("tr[data-idx]").forEach((row) => {
      wireRow(row, Number(row.dataset.idx));
    });
  }

  updateTotals();
}

// Pure row template — used by renderGrid and replaceRowInPlace.
function rowHtml(e, idx, isSubmitted) {
  const job = jobsById.get(e.job_id);
  const jobStatus = isSubmitted ? (e.job_status_snapshot || job?.status || "") : (job?.status || "");
  const dept = deptCodesById.get(e.dept_code_id);
  const task = tasksById.get(e.task_id);
  const rowTotal = DAYS.reduce((sum, d) => sum + Number(e[`${d}_hours`] || 0), 0);

  const ro = isSubmitted ? "readonly" : "";
  const isLeaveRow = !!job?.is_leave;
  const deptRo = isSubmitted || isLeaveRow ? "readonly" : "";
  const taskRo = isSubmitted || isLeaveRow ? "readonly" : "";

  return `
    <tr data-entry-id="${e.id}" data-idx="${idx}">
      <td>
        <div class="ac-wrap">
          <input class="ac-job" value="${escapeHtml(job?.job_code || "")}" data-selected-id="${e.job_id || ""}" placeholder="Type to search…" ${ro} />
          <div class="ac-list"></div>
        </div>
      </td>
      <td><span class="small status-badge status-${jobStatus.toLowerCase()}">${escapeHtml(jobStatus)}</span></td>
      <td>
        <div class="ac-wrap">
          <input class="ac-dept" value="${isLeaveRow ? "" : escapeHtml(dept?.code || "")}" data-selected-id="${isLeaveRow ? "" : (e.dept_code_id || "")}" placeholder="${isLeaveRow ? "—" : "Dept…"}" ${deptRo} style="${isLeaveRow ? "background:var(--surface-alt);color:var(--text-muted)" : ""}" />
          <div class="ac-list"></div>
        </div>
      </td>
      <td>
        <div class="ac-wrap">
          <input class="ac-task" value="${isLeaveRow ? "" : escapeHtml(task?.task_code || "")}" data-selected-id="${isLeaveRow ? "" : (e.task_id || "")}" placeholder="${isLeaveRow ? "—" : "Task…"}" ${taskRo} style="${isLeaveRow ? "background:var(--surface-alt);color:var(--text-muted)" : ""}" />
          <div class="ac-list"></div>
        </div>
      </td>
      <td>
        <input class="desc-input" value="${escapeHtml(e.description || "")}" placeholder="Description…" style="width:100%" ${ro} />
      </td>
      ${DAYS.map((d, i) => `
        <td class="day-col${i >= 5 ? " day-weekend" : ""}">
          <input type="number" class="hours-input" data-day="${d}"
            value="${Number(e[`${d}_hours`]) || ""}" min="0" max="24" step="0.25"
            style="text-align:center" ${ro} />
        </td>
      `).join("")}
      <td class="day-col row-total"><strong>${rowTotal}</strong></td>
      <td>
        ${isSubmitted ? "" : `<button class="ghost small delete-entry-btn" title="Remove row">✕</button>`}
      </td>
    </tr>
  `;
}

// Wire all input handlers + autocompletes for a single row. Used by both
// the full renderGrid pass and replaceRowInPlace.
function wireRow(row, idx) {
  setupAC(row.querySelector(".ac-job"), jobItems, {
    requireQuery: true,
    onSelect: (it) => {
      const wasLeave = !!jobsById.get(entries[idx].job_id)?.is_leave;
      entries[idx].job_id = it.id;
      const fields = ["job_id"];
      if (it.is_leave) {
        entries[idx].dept_code_id = null;
        entries[idx].task_id = null;
        fields.push("dept_code_id", "task_id");
        warnIfLeaveNotEntitled(it);
      }
      saveEntry(entries[idx], fields);
      // Only the status badge cell needs refreshing when is_leave didn't
      // flip; the autocomplete already wrote the input value. When it
      // flips, the dept/task cells need new readonly state — replace the
      // single row in place instead of redrawing the whole grid.
      if (wasLeave === !!it.is_leave) {
        updateRowStatusBadge(row, entries[idx]);
      } else {
        replaceRowInPlace(idx);
      }
    },
    onClear: () => {
      const wasLeave = !!jobsById.get(entries[idx].job_id)?.is_leave;
      entries[idx].job_id = null;
      saveEntry(entries[idx], ["job_id"]);
      if (wasLeave) {
        // Dept/task were forced read-only; need a re-render so they go
        // back to editable.
        replaceRowInPlace(idx);
      } else {
        updateRowStatusBadge(row, entries[idx]);
      }
    },
  });

  const entryJob = jobsById.get(entries[idx]?.job_id);
  if (!entryJob?.is_leave) {
    setupAC(row.querySelector(".ac-dept"), deptItems, {
      onSelect: (it) => { entries[idx].dept_code_id = it.id; saveEntry(entries[idx], ["dept_code_id"]); },
      onClear: () => { entries[idx].dept_code_id = null; saveEntry(entries[idx], ["dept_code_id"]); },
    });
    setupAC(row.querySelector(".ac-task"), taskItems, {
      onSelect: (it) => { entries[idx].task_id = it.id; saveEntry(entries[idx], ["task_id"]); },
      onClear: () => { entries[idx].task_id = null; saveEntry(entries[idx], ["task_id"]); },
    });
  }

  const descInp = row.querySelector(".desc-input");
  if (descInp) {
    let descTimer;
    descInp.addEventListener("input", () => {
      entries[idx].description = descInp.value;
      clearTimeout(descTimer);
      descTimer = setTimeout(() => saveEntry(entries[idx], ["description"]), 600);
    });
  }

  row.querySelectorAll(".hours-input").forEach((inp) => {
    // <input type="number"> ticks its value on mousewheel/trackpad scroll
    // when focused. That makes it really easy to silently nudge an
    // already-saved cell while scrolling the timesheet — disable it.
    inp.addEventListener("wheel", (e) => {
      if (document.activeElement === inp) {
        inp.blur();
      }
    }, { passive: true });
    let timer;
    inp.addEventListener("input", () => {
      const day = inp.dataset.day;
      // Clamp to [0, 24] on every keystroke. The <input min/max> only
      // validates on form submit, and parseFloat happily accepts negative
      // values or scientific notation. The DB also has a CHECK constraint
      // (migration 054); this is the user-friendly client-side guard.
      const raw = parseFloat(inp.value);
      const clamped = Number.isFinite(raw) ? Math.max(0, Math.min(24, raw)) : 0;
      entries[idx][`${day}_hours`] = clamped;
      const rowTotal = DAYS.reduce((sum, d) => sum + Number(entries[idx][`${d}_hours`] || 0), 0);
      row.querySelector(".row-total strong").textContent = rowTotal;
      updateTotals();
      clearTimeout(timer);
      timer = setTimeout(() => saveEntry(entries[idx], [`${day}_hours`]), 400);
    });
  });

  const delBtn = row.querySelector(".delete-entry-btn");
  if (delBtn) {
    delBtn.addEventListener("click", async () => {
      const entryId = Number(row.dataset.entryId);
      try {
        const { error } = await sb.from("timesheet_entries").delete().eq("id", entryId);
        if (error) throw error;
        entries = entries.filter((x) => x.id !== entryId);
        renderGrid();
        notice("Row removed", "success");
      } catch (err) {
        notice(err.message || "Delete failed", "error");
      }
    });
  }
}

function updateRowStatusBadge(row, entry) {
  const job = jobsById.get(entry.job_id);
  const status = job?.status || "";
  const cell = row.children[1];
  if (cell) {
    cell.innerHTML = `<span class="small status-badge status-${status.toLowerCase()}">${escapeHtml(status)}</span>`;
  }
}

function replaceRowInPlace(idx) {
  const body = document.getElementById("ts-body");
  const oldRow = body.querySelector(`tr[data-idx="${idx}"]`);
  if (!oldRow) { renderGrid(); return; }
  const isSubmitted = !ADMIN_MODE && isTsSubmittedOrApproved(tsStatus);
  const tmp = document.createElement("tbody");
  tmp.innerHTML = rowHtml(entries[idx], idx, isSubmitted).trim();
  const newRow = tmp.firstElementChild;
  oldRow.replaceWith(newRow);
  if (!isSubmitted) wireRow(newRow, idx);
}

function updateTotals() {
  let weekTotal = 0;
  for (const d of DAYS) {
    const dayTotal = entries.reduce((sum, e) => sum + Number(e[`${d}_hours`] || 0), 0);
    document.getElementById(`total-${d}`).textContent = dayTotal || "";
    weekTotal += dayTotal;
  }
  document.getElementById("total-week").innerHTML = `<strong>${weekTotal}</strong>`;
}

/* ---------------------------------------------------------------- save entry */

// Per-row write chain. Each saveEntry queues behind the previous save
// for the same row so two requests for the same row can't arrive at the
// DB out of order (network reordering would otherwise leave the earlier,
// stale value persisted while the UI shows the later one). Different
// rows save in parallel — the chain is scoped per entry.id.
const saveChains = new Map();

async function saveEntry(entry, changedFields) {
  if (!Array.isArray(changedFields) || !changedFields.length) return;
  const update = {};
  for (const f of changedFields) {
    if (f === "description") {
      update.description = entry.description || null;
    } else if (f.endsWith("_hours")) {
      update[f] = Number(entry[f]) || 0;
    } else {
      // job_id / task_id / dept_code_id
      update[f] = entry[f];
    }
  }
  const prev = saveChains.get(entry.id) || Promise.resolve();
  const next = prev.then(async () => {
    try {
      const { error } = await sb.from("timesheet_entries").update(update).eq("id", entry.id);
      if (error) throw error;
      invalidateCalCache();
    } catch (err) {
      console.error("Save failed", err);
      notice(err.message || "Failed to save", "error");
    }
  });
  saveChains.set(entry.id, next);
  next.finally(() => {
    if (saveChains.get(entry.id) === next) saveChains.delete(entry.id);
  });
}

/* ---------------------------------------------------------------- add row */

document.getElementById("add-row-btn").addEventListener("click", async () => {
  if (!timesheetId) return notice("Timesheet not loaded yet", "warn");
  const sortOrder = Math.max(-1, ...entries.map((e) => Number(e.sort_order) || 0)) + 1;
  try {
    const { data, error } = await sb
      .from("timesheet_entries")
      .insert({ timesheet_id: timesheetId, sort_order: sortOrder })
      .select()
      .single();
    if (error) throw error;
    entries.push(data);
    renderGrid();
  } catch (err) {
    notice(err.message || "Failed to add row", "error");
  }
});

/* ---------------------------------------------------------------- import last week */

document.getElementById("import-last-week").addEventListener("click", async () => {
  if (entries.length > 0) {
    if (!await confirmDialog({
      title: "Import last week's tasks",
      message: "Copy last week's task list (job/dept/task/description, no hours) into this week. Existing rows that match are skipped, so anything you've already added stays. Continue?",
      confirmText: "Import",
    })) return;
  }
  try {
    const { data, error } = await sb.rpc("import_last_week_tasks", {
      p_week_start: fmtDate(weekStart),
    });
    if (error) throw error;
    if (data === 0) {
      notice("No tasks found from last week, or current week already has entries", "warn");
      return;
    }
    notice(`Imported ${data} tasks from last week`, "success");
    await loadWeek();
  } catch (err) {
    notice(err.message || "Import failed", "error");
  }
});

/* ---------------------------------------------------------------- submit timesheet */

document.getElementById("submit-ts-btn").addEventListener("click", () => {
  if (!timesheetId) return notice("Timesheet not loaded yet", "warn");
  if (isTsSubmittedOrApproved(tsStatus)) return notice("This timesheet has already been submitted", "info");

  if (!entries.length) {
    notice("Add at least one task before submitting", "warn");
    return;
  }

  // Validate that every entry has required fields
  const incomplete = [];
  entries.forEach((e, i) => {
    const hasHours = DAYS.some((d) => Number(e[`${d}_hours`]) > 0);
    if (!hasHours) return;
    const job = jobsById.get(e.job_id);
    if (job?.is_leave) return;
    const missing = [];
    if (!e.job_id) missing.push("Job");
    if (!e.dept_code_id) missing.push("Department");
    if (requireTask && !e.task_id) missing.push("Task");
    if (missing.length) incomplete.push({ row: i + 1, missing });
  });
  if (incomplete.length) {
    const msg = incomplete.map((r) => `Row ${r.row}: ${r.missing.join(", ")}`).join(". ");
    notice(`Please fill in required fields — ${msg}`, "warn");
    return;
  }

  const totalHours = entries.reduce((sum, e) =>
    sum + DAYS.reduce((s, d) => s + (Number(e[`${d}_hours`]) || 0), 0), 0);

  if (totalHours === 0) {
    notice("Log some hours before submitting", "warn");
    return;
  }

  const taskCount = entries.length;
  const dialog = document.getElementById("submit-confirm-dialog");
  const msgEl = document.getElementById("submit-confirm-msg");
  const warnEl = document.getElementById("submit-confirm-warn");

  msgEl.textContent = `Submit ${totalHours}h across ${taskCount} task${taskCount !== 1 ? "s" : ""}?`;
  warnEl.textContent = totalHours < 40
    ? `This timesheet has less than 40 hours logged. You won't be able to edit it after submission.`
    : `You won't be able to edit it after submission.`;

  dialog.showModal();
});

document.getElementById("submit-cancel-btn").addEventListener("click", () => {
  document.getElementById("submit-confirm-dialog").close();
});

document.getElementById("submit-confirm-btn").addEventListener("click", async () => {
  const dialog = document.getElementById("submit-confirm-dialog");
  dialog.close();

  const btn = document.getElementById("submit-ts-btn");
  btn.disabled = true;
  btn.textContent = "Submitting…";

  try {
    try {
      await sb.rpc("snapshot_timesheet_job_statuses", { p_timesheet_id: timesheetId });
    } catch (err) {
      console.warn("snapshot_timesheet_job_statuses failed:", err);
    }

    const { data: rows, error } = await sb
      .from("timesheets")
      .update({ status: "submitted", submitted_at: new Date().toISOString() })
      .eq("id", timesheetId)
      .in("status", ["draft", "rejected"])
      .select("id");
    if (error) throw error;
    if (!rows?.length) {
      // Either a manager rejected/approved while the dialog was open, or
      // the row no longer satisfies the RLS predicate. Reload so the user
      // sees the current state instead of a phantom "submitted" UI.
      notice("This timesheet is no longer in a draft state — reloading", "warn");
      btn.disabled = false;
      btn.textContent = "Submit Timesheet";
      await loadWeek();
      return;
    }

    tsStatus = "submitted";
    tsSubmittedAt = new Date().toISOString();
    renderStatusBadge();
    invalidateCalCache();
    invalidateWeekDashboard(currentOrgId, fmtDate(weekStart));
    notice("Timesheet submitted", "success");
    renderGrid();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Submit Timesheet";
    notice(err.message || "Submit failed", "error");
  }
});

/* ---------------------------------------------------------------- load org deadline settings */

async function loadOrgDeadline() {
  try {
    const { data } = await sb
      .from("organisations")
      .select("deadline_week, deadline_day, deadline_time, autofill_public_holidays, public_holiday_hours, public_holiday_job_id, employment_type_settings")
      .eq("id", currentOrgId)
      .maybeSingle();
    if (data) {
      orgDeadline.week = data.deadline_week || "following_week";
      orgDeadline.day = data.deadline_day || "monday";
      orgDeadline.time = (data.deadline_time || "08:00").slice(0, 5);
      orgAutofillPH = !!data.autofill_public_holidays;
      orgPHHours = Number(data.public_holiday_hours) || 8;
      orgPHJobId = data.public_holiday_job_id || null;
      orgEmpTypeSettings = data.employment_type_settings || null;
    }
  } catch (err) {
    console.warn("org deadline settings load failed:", err);
    notice("Couldn't load deadline settings — countdown may be inaccurate", "warn");
  }
}

/* ---------------------------------------------------------------- overhead (leave-only) view */

async function showOverheadView() {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  document.getElementById("hub-view").style.display = "none";
  document.getElementById("editor-view").style.display = "none";
  document.getElementById("overhead-view").style.display = "";

  // Leave-request widgets are dormant — code kept for future re-enable.
  // await loadOverheadLeaveBalances();
  // await loadOverheadLeaveRequests();
}

async function loadOverheadLeaveBalances() {
  const card = document.getElementById("oh-leave-balance-card");
  const body = document.getElementById("oh-leave-balance-body");

  const { data: types } = await sb
    .from("leave_types")
    .select("id, name, code, unit, sort_order, active")
    .eq("organisation_id", currentOrgId)
    .eq("active", true)
    .order("sort_order");
  leaveTypes = types || [];

  const { data } = await sb
    .from("leave_balances")
    .select("balance, used_total, leave_types(name, unit, sort_order)")
    .eq("user_id", employee.id);

  card.style.display = "";

  if (!data?.length) {
    body.innerHTML = `<div class="muted small" style="padding:8px">No balances yet. Contact admin to set up entitlements.</div>`;
    return;
  }

  const rows = data
    .filter((r) => r.leave_types)
    .sort((a, b) => (a.leave_types.sort_order || 0) - (b.leave_types.sort_order || 0));

  body.innerHTML = rows.map((r) => `
    <div class="leave-balance-tile">
      <div class="lb-name">${escapeHtml(r.leave_types.name)}</div>
      <div class="lb-value">${Number(r.balance).toFixed(r.leave_types.unit === "days" ? 1 : 2)}<span class="lb-unit">${r.leave_types.unit === "days" ? "days" : "hrs"}</span></div>
      <div class="lb-used">${Number(r.used_total).toFixed(1)} used</div>
    </div>
  `).join("");
}

async function loadOverheadLeaveRequests() {
  const card = document.getElementById("oh-leave-requests-card");
  const body = document.getElementById("oh-leave-requests-body");

  const { data } = await sb
    .from("leave_requests")
    .select("id, start_date, end_date, hours_per_day, status, reason, leave_type_id, leave_types(name)")
    .eq("user_id", employee.id)
    .order("created_at", { ascending: false })
    .limit(20);

  if (!data?.length) {
    card.style.display = "none";
    return;
  }

  card.style.display = "";
  body.innerHTML = data.map((r) => {
    const statusClass = r.status === "approved" ? "chip-submitted" :
                        r.status === "rejected" ? "chip-pending" : "chip-pending";
    const canCancel = r.status === "pending";
    const dateRange = r.start_date === r.end_date
      ? r.start_date
      : `${r.start_date} → ${r.end_date}`;
    return `<tr data-id="${r.id}">
      <td>${escapeHtml(r.leave_types?.name || "")}</td>
      <td class="small">${dateRange}</td>
      <td class="num">${r.hours_per_day}</td>
      <td><span class="chip-dash ${statusClass}">${r.status}</span></td>
      <td class="small muted">${escapeHtml(r.reason || "")}</td>
      <td>${canCancel ? `<button class="ghost small oh-cancel-lr-btn">Cancel</button>` : ""}</td>
    </tr>`;
  }).join("");

  body.querySelectorAll(".oh-cancel-lr-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.closest("tr").dataset.id);
      if (!await confirmDialog({ title: "Cancel leave request", message: "Cancel this leave request?", confirmText: "Cancel request", danger: true })) return;
      const { error } = await sb.from("leave_requests")
        .update({ status: "cancelled" }).eq("id", id);
      if (error) return notice(error.message, "error");
      notice("Request cancelled", "success");
      await loadOverheadLeaveRequests();
    });
  });
}

document.getElementById("oh-request-leave-btn")?.addEventListener("click", async () => {
  await loadLeaveJobs();
  const dialog = document.getElementById("leave-request-dialog");
  const sel = document.getElementById("lr-type");
  sel.innerHTML = leaveJobs
    .filter((j) => j.leave_type_id)
    .map((j) =>
      `<option value="${j.leave_type_id}">${escapeHtml(j.job_code)}${j.description ? " — " + escapeHtml(j.description) : ""}</option>`
    ).join("");
  document.getElementById("lr-start").value = "";
  document.getElementById("lr-end").value = "";
  document.getElementById("lr-hours").value = "8";
  document.getElementById("lr-reason").value = "";
  document.getElementById("lr-skip-weekends").checked = true;
  dialog.showModal();
});

/* ---------------------------------------------------------------- boot */

// Wait for the department flags before deciding which view to show. The
// promise was fired in parallel with renderTopbar so this is usually already
// resolved by the time we get here.
const deptInfo = await deptInfoPromise;
isOverhead = deptInfo.isOverhead;
requireTask = deptInfo.requireTask;

if (ADMIN_MODE) {
  // Admin-edit override: jump straight to the editor for the target week.
  // Entries are autosaved, so the "Back" button is really "done editing".
  ensureLookups();
  document.getElementById("back-to-hub").textContent = "← Save & return";
  const parsed = new Date(ADMIN_TARGET_WEEK + "T00:00:00");
  if (isNaN(parsed)) {
    notice("Invalid week parameter", "error", { sticky: true });
  } else {
    showEditor(getMonday(parsed));
  }
} else if (isOverhead) {
  await showOverheadView();
} else {
  // Pre-warm lookups in the background so the editor opens fast, but don't
  // block the hub on them — only the editor needs jobs/tasks/dept-codes.
  ensureLookups();

  const urlWeek = new URLSearchParams(location.search).get("week");
  if (urlWeek) {
    const parsed = new Date(urlWeek + "T00:00:00");
    if (!isNaN(parsed)) {
      showEditor(getMonday(parsed));
    } else {
      showHub();
    }
  } else {
    showHub();
  }
}
