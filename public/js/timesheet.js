// PTL Timesheet — My Timesheets hub + weekly grid editor.

import { getSupabase } from "/js/supabase-client.js";
import { notice, escapeHtml, renderTopbar } from "/js/shared.js";

const sb = await getSupabase();

/* ---------------------------------------------------------------- auth */

const { data: { session } } = await sb.auth.getSession();
if (!session) { location.replace("/signin.html"); throw new Error("not signed in"); }

let employee = null;
let isDeveloper = false;
let adminRow = null;
let isManager = false;
try { const r = await sb.rpc("is_developer"); isDeveloper = !!r.data; } catch {}
try {
  const r = await sb.from("admins").select("organisation_id, role").eq("user_id", session.user.id).maybeSingle();
  adminRow = r.data;
} catch {}
try {
  const r = await sb.from("users").select("id, organisation_id, name, is_manager").eq("auth_user_id", session.user.id).maybeSingle();
  employee = r.data;
  isManager = !!r.data?.is_manager;
} catch {}

if (!employee) {
  location.replace("/welcome.html");
  throw new Error("no employee record");
}

const currentOrgId = employee.organisation_id;

renderTopbar({
  session,
  isDeveloper,
  isManager,
  adminRow,
  orgs: null,
  currentOrgId,
  onOrgChange: () => {},
  active: "timesheet",
});

/* ---------------------------------------------------------------- state */

const DAYS = ["mon","tue","wed","thu","fri","sat","sun"];
const DAY_NAMES = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
let weekStart = null;
let timesheetId = null;
let tsStatus = "draft";
let entries = [];
let jobs = [];
let tasks = [];
let deptCodes = [];
let holidays = {};
let calMonth = new Date();
let orgDeadline = { week: "following_week", day: "monday", time: "08:00" };

function getMonday(d) {
  const dt = new Date(d);
  const day = dt.getDay();
  const diff = dt.getDate() - day + (day === 0 ? -6 : 1);
  dt.setDate(diff);
  dt.setHours(0, 0, 0, 0);
  return dt;
}

function fmtDate(d) { return d.toISOString().slice(0, 10); }
function fmtShortDate(d) { return `${d.getDate()}/${d.getMonth() + 1}`; }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

function weekLabel() {
  const end = addDays(weekStart, 6);
  const opts = { day: "numeric", month: "short" };
  return `${weekStart.toLocaleDateString(undefined, opts)} — ${end.toLocaleDateString(undefined, opts)}, ${end.getFullYear()}`;
}

const thisMonday = getMonday(new Date());

async function loadHolidays() {
  const { data } = await sb
    .from("public_holidays")
    .select("holiday_date, name")
    .eq("organisation_id", currentOrgId);
  holidays = {};
  for (const h of data || []) holidays[h.holiday_date] = h.name;
}
loadHolidays();

/* ---------------------------------------------------------------- views */

function showHub() {
  document.getElementById("hub-view").style.display = "";
  document.getElementById("editor-view").style.display = "none";
  document.querySelector(".container").classList.remove("ts-container");
  loadCurrentWeekCard();
  loadQuickStats();
  loadLeaveBalances();
  loadMyLeaveRequests();
  renderCalendar();
}

let leaveTypes = [];

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
      if (!confirm("Cancel this leave request?")) return;
      const { error } = await sb.from("leave_requests")
        .update({ status: "cancelled" }).eq("id", id);
      if (error) return notice(error.message, "error");
      notice("Request cancelled", "success");
      await loadMyLeaveRequests();
    });
  });
}

document.getElementById("request-leave-btn")?.addEventListener("click", () => {
  const dialog = document.getElementById("leave-request-dialog");
  const sel = document.getElementById("lr-type");
  sel.innerHTML = leaveTypes.map((t) =>
    `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");
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

  if (!startDate || !endDate) return notice("Pick start and end dates", "warn");
  if (new Date(endDate) < new Date(startDate)) return notice("End date must be after start date", "warn");

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
  await loadMyLeaveRequests();
});

function showEditor(ws) {
  weekStart = ws;
  document.getElementById("hub-view").style.display = "none";
  document.getElementById("editor-view").style.display = "";
  document.querySelector(".container").classList.add("ts-container");
  loadWeek();
}

document.getElementById("back-to-hub").addEventListener("click", () => showHub());

/* ---------------------------------------------------------------- current week card */

function getDeadline() {
  const targetDayIdx = DAY_NAMES.indexOf(orgDeadline.day);
  const [hh, mm] = (orgDeadline.time || "08:00").split(":").map(Number);

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
  deadline.setHours(hh || 8, mm || 0, 0, 0);
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
    const { data: ts } = await sb
      .from("timesheets")
      .select("id, status")
      .eq("user_id", employee.id)
      .eq("week_start", ws)
      .maybeSingle();

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

    card.classList.remove("submitted", "draft");

    if (ts?.status === "submitted" || ts?.status === "approved") {
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
    } else {
      card.classList.add("draft");
      const deadline = getDeadline();
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

/* ---------------------------------------------------------------- quick stats */

async function loadQuickStats() {
  const el = document.getElementById("quick-stats");
  if (!el) return;

  try {
    // Load all timesheets for stats
    const { data: allTs } = await sb
      .from("timesheets")
      .select("id, week_start, status")
      .eq("user_id", employee.id)
      .order("week_start", { ascending: false })
      .limit(52);

    if (!allTs?.length) {
      el.innerHTML = `<span class="muted small">No timesheet history yet</span>`;
      return;
    }

    // Current month hours
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const monthTs = allTs.filter((t) => {
      const d = new Date(t.week_start);
      return d >= monthStart && d <= monthEnd;
    });

    let monthHours = 0;
    if (monthTs.length) {
      const ids = monthTs.map((t) => t.id);
      const { data: ents } = await sb
        .from("timesheet_entries")
        .select("timesheet_id, mon_hours, tue_hours, wed_hours, thu_hours, fri_hours, sat_hours, sun_hours")
        .in("timesheet_id", ids);
      for (const e of ents || []) {
        monthHours += DAYS.reduce((s, d) => s + (Number(e[`${d}_hours`]) || 0), 0);
      }
    }

    // Submission streak
    let streak = 0;
    const sorted = allTs.filter((t) => t.status === "submitted" || t.status === "approved")
      .sort((a, b) => b.week_start.localeCompare(a.week_start));
    if (sorted.length) {
      let expected = getMonday(new Date());
      // Current week doesn't count unless submitted
      const currentSubmitted = sorted[0]?.week_start === fmtDate(expected);
      if (!currentSubmitted) expected = addDays(expected, -7);
      for (const t of sorted) {
        if (t.week_start === fmtDate(expected)) {
          streak++;
          expected = addDays(expected, -7);
        } else {
          break;
        }
      }
    }

    // Avg hours per week (last 12 weeks)
    const recent = allTs.slice(0, 12);
    let totalRecentHours = 0;
    if (recent.length) {
      const ids = recent.map((t) => t.id);
      const { data: ents } = await sb
        .from("timesheet_entries")
        .select("timesheet_id, mon_hours, tue_hours, wed_hours, thu_hours, fri_hours, sat_hours, sun_hours")
        .in("timesheet_id", ids);
      for (const e of ents || []) {
        totalRecentHours += DAYS.reduce((s, d) => s + (Number(e[`${d}_hours`]) || 0), 0);
      }
    }
    const avgHours = recent.length ? Math.round(totalRecentHours / recent.length * 10) / 10 : 0;

    const monthName = now.toLocaleDateString(undefined, { month: "long" });

    el.innerHTML = `
      <div class="stat-item">
        <span class="stat-value">${Math.round(monthHours)}h</span>
        <span class="stat-label">${monthName}</span>
      </div>
      <div class="stat-item">
        <span class="stat-value">${streak}</span>
        <span class="stat-label">week streak</span>
      </div>
      <div class="stat-item">
        <span class="stat-value">${avgHours}h</span>
        <span class="stat-label">avg / week</span>
      </div>
    `;
  } catch {
    el.innerHTML = "";
  }
}

/* ---------------------------------------------------------------- week calendar */

async function renderCalendar() {
  const label = document.getElementById("cal-month-label");
  const body = document.getElementById("cal-body");

  const year = calMonth.getFullYear();
  const month = calMonth.getMonth();
  label.textContent = calMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  // Get first Monday on or before the 1st of this month
  const first = new Date(year, month, 1);
  let start = getMonday(first);

  // Load timesheets for this range
  const end = new Date(year, month + 1, 7);
  let tsMap = {};
  try {
    const { data } = await sb
      .from("timesheets")
      .select("week_start, status, id")
      .eq("user_id", employee.id)
      .gte("week_start", fmtDate(start))
      .lte("week_start", fmtDate(end));

    // Load entry totals
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

      for (const t of data || []) {
        tsMap[t.week_start] = { status: t.status, hours: totals[t.id] || 0 };
      }
    }
  } catch {}

  let rows = "";
  let weekDate = new Date(start);

  while (weekDate.getMonth() <= month || weekDate < first) {
    const mon = new Date(weekDate);
    const ws = fmtDate(mon);
    const isCurrent = fmtDate(mon) === fmtDate(thisMonday);
    const ts = tsMap[ws];

    const dayCells = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(mon, i);
      const inMonth = d.getMonth() === month;
      const isWeekend = i >= 5;
      const isHoliday = !!holidays[fmtDate(d)];
      const cls = [
        inMonth ? "" : "muted",
        isWeekend ? "cal-weekend" : "",
        isHoliday ? "cal-holiday" : "",
      ].filter(Boolean).join(" ");
      const title = isHoliday ? ` title="${escapeHtml(holidays[fmtDate(d)])}"` : "";
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
      ts?.status === "submitted" || ts?.status === "approved" ? "week-submitted" :
      ts?.status === "draft" ? "week-draft" : "";

    rows += `<tr class="week-row ${rowClass}" data-week="${ws}">
      ${dayCells.join("")}
      <td class="week-status">${statusBadge}</td>
      <td class="small">${hours}</td>
      <td>${action}</td>
    </tr>`;

    weekDate.setDate(weekDate.getDate() + 7);
    if (weekDate.getMonth() > month && weekDate.getFullYear() >= year && weekDate > addDays(first, 28)) break;
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
  renderCalendar();
});
document.getElementById("cal-next").addEventListener("click", () => {
  calMonth.setMonth(calMonth.getMonth() + 1);
  renderCalendar();
});

/* ---------------------------------------------------------------- load jobs + tasks */

async function loadLookups() {
  const PAGE = 1000;
  let allJobs = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from("jobs")
      .select("id, job_code, description, status")
      .eq("organisation_id", currentOrgId)
      .order("job_code")
      .range(from, from + PAGE - 1);
    if (error) break;
    allJobs = allJobs.concat(data || []);
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  jobs = allJobs;

  const { data: taskData } = await sb
    .from("tasks")
    .select("id, task_code, description, status")
    .eq("organisation_id", currentOrgId)
    .eq("status", "ACTIVE")
    .order("task_code");
  tasks = taskData || [];

  const { data: deptData } = await sb
    .from("department_codes")
    .select("id, code, description, status")
    .eq("organisation_id", currentOrgId)
    .eq("status", "ACTIVE")
    .order("code");
  deptCodes = deptData || [];
}

/* ---------------------------------------------------------------- load timesheet (editor) */

async function loadWeek() {
  document.getElementById("week-label").textContent = weekLabel();

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
    const { data, error } = await sb.rpc("get_or_create_timesheet", {
      p_week_start: fmtDate(weekStart),
    });
    if (error) throw error;
    timesheetId = data;
  } catch (err) {
    console.error(err);
    notice(err.message || "Failed to load timesheet", "error");
    return;
  }

  try {
    const { data } = await sb.from("timesheets").select("status").eq("id", timesheetId).maybeSingle();
    tsStatus = data?.status || "draft";
    document.getElementById("ts-status").textContent = tsStatus ? `Status: ${tsStatus}` : "";
  } catch {}

  try {
    const { data, error } = await sb
      .from("timesheet_entries")
      .select("id, job_id, task_id, dept_code_id, description, sort_order, job_status_snapshot, mon_hours, tue_hours, wed_hours, thu_hours, fri_hours, sat_hours, sun_hours")
      .eq("timesheet_id", timesheetId)
      .order("sort_order")
      .order("id");
    if (error) throw error;
    entries = data || [];
  } catch (err) {
    console.error(err);
    notice(err.message || "Failed to load entries", "error");
    entries = [];
  }

  renderGrid();
}

/* ---------------------------------------------------------------- autocomplete helper */

function setupAC(input, items, { onSelect, onClear }) {
  const wrap = input.closest(".ac-wrap");
  const list = wrap.querySelector(".ac-list");
  let highlighted = -1;

  function render(query) {
    const q = (query || "").toLowerCase();
    const filtered = q
      ? items.filter((it) => it._label.toLowerCase().includes(q) || (it._desc || "").toLowerCase().includes(q))
      : items;
    const show = filtered.slice(0, 100);
    highlighted = -1;
    list.innerHTML =
      show.map((it, i) =>
        `<div class="ac-item" data-idx="${i}" data-id="${it.id}">
          <span>${escapeHtml(it._label)}</span>
          ${it._desc ? `<span class="ac-desc">${escapeHtml(it._desc)}</span>` : ""}
        </div>`
      ).join("") +
      `<div class="ac-clear" data-action="clear">(clear selection)</div>`;
    list.classList.add("open");
    list._items = show;
  }

  input.addEventListener("focus", () => render(input.value));
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

/* ---------------------------------------------------------------- render grid */

function renderGrid() {
  const body = document.getElementById("ts-body");
  const isSubmitted = tsStatus === "submitted" || tsStatus === "approved";

  const jobItems = jobs.map((j) => ({ ...j, _label: j.job_code, _desc: j.description || "" }));
  const deptItems = deptCodes.map((dc) => ({ ...dc, _label: dc.code, _desc: dc.description || "" }));
  const taskItems = tasks.map((t) => ({ ...t, _label: t.task_code, _desc: t.description || "" }));

  // Show/hide submit bar based on status
  const submitBar = document.getElementById("submit-bar");
  const submitBtn = document.getElementById("submit-ts-btn");
  if (isSubmitted) {
    submitBar.style.display = "none";
  } else {
    submitBar.style.display = "";
    submitBtn.textContent = "Submit Timesheet";
    submitBtn.disabled = false;
  }

  if (!entries.length) {
    body.innerHTML = `<tr><td colspan="14" class="muted small" style="text-align:center;padding:24px">No tasks yet — click "+ Add task" below to start.</td></tr>`;
    updateTotals();
    return;
  }

  body.innerHTML = entries.map((e, idx) => {
    const job = jobs.find((j) => j.id === e.job_id);
    const jobStatus = isSubmitted ? (e.job_status_snapshot || job?.status || "") : (job?.status || "");
    const dept = deptCodes.find((dc) => dc.id === e.dept_code_id);
    const task = tasks.find((t) => t.id === e.task_id);
    const rowTotal = DAYS.reduce((sum, d) => sum + Number(e[`${d}_hours`] || 0), 0);

    return `
      <tr data-entry-id="${e.id}" data-idx="${idx}">
        <td>
          <div class="ac-wrap">
            <input class="ac-job" value="${escapeHtml(job?.job_code || "")}" data-selected-id="${e.job_id || ""}" placeholder="Type to search…" />
            <div class="ac-list"></div>
          </div>
        </td>
        <td><span class="small status-badge status-${jobStatus.toLowerCase()}">${escapeHtml(jobStatus)}</span></td>
        <td>
          <div class="ac-wrap">
            <input class="ac-dept" value="${escapeHtml(dept?.code || "")}" data-selected-id="${e.dept_code_id || ""}" placeholder="Dept…" />
            <div class="ac-list"></div>
          </div>
        </td>
        <td>
          <div class="ac-wrap">
            <input class="ac-task" value="${escapeHtml(task?.task_code || "")}" data-selected-id="${e.task_id || ""}" placeholder="Task…" />
            <div class="ac-list"></div>
          </div>
        </td>
        <td>
          <input class="desc-input" value="${escapeHtml(e.description || "")}" placeholder="Description…" style="width:100%" />
        </td>
        ${DAYS.map((d, i) => `
          <td class="day-col${i >= 5 ? " day-weekend" : ""}">
            <input type="number" class="hours-input" data-day="${d}"
              value="${Number(e[`${d}_hours`]) || ""}" min="0" max="24" step="0.25"
              style="text-align:center" />
          </td>
        `).join("")}
        <td class="day-col row-total"><strong>${rowTotal}</strong></td>
        <td>
          <button class="ghost small delete-entry-btn" title="Remove row">✕</button>
        </td>
      </tr>
    `;
  }).join("");

  // Wire up autocomplete
  body.querySelectorAll("tr[data-idx]").forEach((row) => {
    const idx = Number(row.dataset.idx);

    setupAC(row.querySelector(".ac-job"), jobItems, {
      onSelect: (it) => {
        entries[idx].job_id = it.id;
        saveEntry(entries[idx]);
        const badge = row.querySelector(".status-badge");
        if (badge) {
          badge.textContent = it.status || "";
          badge.className = `small status-badge status-${(it.status || "").toLowerCase()}`;
        }
      },
      onClear: () => { entries[idx].job_id = null; saveEntry(entries[idx]); },
    });

    setupAC(row.querySelector(".ac-dept"), deptItems, {
      onSelect: (it) => { entries[idx].dept_code_id = it.id; saveEntry(entries[idx]); },
      onClear: () => { entries[idx].dept_code_id = null; saveEntry(entries[idx]); },
    });

    setupAC(row.querySelector(".ac-task"), taskItems, {
      onSelect: (it) => { entries[idx].task_id = it.id; saveEntry(entries[idx]); },
      onClear: () => { entries[idx].task_id = null; saveEntry(entries[idx]); },
    });
  });

  // Description debounced save
  body.querySelectorAll(".desc-input").forEach((inp) => {
    let timer;
    inp.addEventListener("input", (e) => {
      const row = e.target.closest("tr");
      const idx = Number(row.dataset.idx);
      entries[idx].description = inp.value;
      clearTimeout(timer);
      timer = setTimeout(() => saveEntry(entries[idx]), 600);
    });
  });

  // Hours inputs
  body.querySelectorAll(".hours-input").forEach((inp) => {
    let timer;
    inp.addEventListener("input", (e) => {
      const row = e.target.closest("tr");
      const idx = Number(row.dataset.idx);
      const day = inp.dataset.day;
      entries[idx][`${day}_hours`] = parseFloat(inp.value) || 0;
      const rowTotal = DAYS.reduce((sum, d) => sum + Number(entries[idx][`${d}_hours`] || 0), 0);
      row.querySelector(".row-total strong").textContent = rowTotal;
      updateTotals();
      clearTimeout(timer);
      timer = setTimeout(() => saveEntry(entries[idx]), 400);
    });
  });

  // Delete buttons
  body.querySelectorAll(".delete-entry-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const row = e.target.closest("tr");
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
  });

  updateTotals();
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

async function saveEntry(entry) {
  const update = {
    job_id: entry.job_id,
    task_id: entry.task_id,
    dept_code_id: entry.dept_code_id,
    description: entry.description || null,
  };
  for (const d of DAYS) {
    update[`${d}_hours`] = Number(entry[`${d}_hours`]) || 0;
  }
  try {
    const { error } = await sb.from("timesheet_entries").update(update).eq("id", entry.id);
    if (error) throw error;
  } catch (err) {
    console.error("Save failed", err);
    notice(err.message || "Failed to save", "error");
  }
}

/* ---------------------------------------------------------------- add row */

document.getElementById("add-row-btn").addEventListener("click", async () => {
  if (!timesheetId) return;
  const sortOrder = entries.length ? Math.max(...entries.map((e) => e.sort_order)) + 1 : 0;
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
    if (!confirm("This will only work if the current week has no tasks yet. Current entries will be kept. Continue?")) return;
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

document.getElementById("submit-ts-btn").addEventListener("click", async () => {
  if (!timesheetId) return;
  if (tsStatus === "submitted" || tsStatus === "approved") return;

  if (!entries.length) {
    notice("Add at least one task before submitting", "warn");
    return;
  }

  const totalHours = entries.reduce((sum, e) =>
    sum + DAYS.reduce((s, d) => s + (Number(e[`${d}_hours`]) || 0), 0), 0);

  if (totalHours === 0) {
    notice("Log some hours before submitting", "warn");
    return;
  }

  if (!confirm(`Submit this timesheet with ${totalHours}h across ${entries.length} task${entries.length !== 1 ? "s" : ""}? You won't be able to edit it after submission.`)) return;

  const btn = document.getElementById("submit-ts-btn");
  btn.disabled = true;
  btn.textContent = "Submitting…";

  try {
    // Snapshot job statuses
    try {
      await sb.rpc("snapshot_timesheet_job_statuses", { p_timesheet_id: timesheetId });
    } catch {}

    const { error } = await sb
      .from("timesheets")
      .update({ status: "submitted", submitted_at: new Date().toISOString() })
      .eq("id", timesheetId);
    if (error) throw error;

    tsStatus = "submitted";
    document.getElementById("ts-status").textContent = "Status: submitted";
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
      .select("deadline_week, deadline_day, deadline_time")
      .eq("id", currentOrgId)
      .maybeSingle();
    if (data) {
      orgDeadline.week = data.deadline_week || "following_week";
      orgDeadline.day = data.deadline_day || "monday";
      orgDeadline.time = (data.deadline_time || "08:00").slice(0, 5);
    }
  } catch {}
}

/* ---------------------------------------------------------------- boot */

await Promise.all([loadLookups(), loadOrgDeadline()]);

// If ?week= param, go straight to editor
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
