// Employee timesheet page.
// Responsibilities:
//   - load the selected week's draft / submitted data via load_timesheet_week RPC
//   - render the 7-day grid of (project, task) rows
//   - pre-fill from last week on an employee's first-of-the-week open
//   - auto-compute daily / weekly totals + overtime shading
//   - highlight discrepancies between entered hours and clocked hours
//   - save_timesheet_draft / submit_timesheet via RPC

import {
  requireAuth,
  renderTopbar,
  mondayOf,
  isoDate,
  weekDays,
  DOW_LABELS,
  formatShortDate,
  notice,
} from "/js/shared.js";

const { supabase, authUser, employee, roles } = await requireAuth({
  requireEmployee: true,
});
renderTopbar({ authUser, employee, roles }, "timesheet");

/* -------------------------------------------------------------- state */

/** @type {{projects:any[], tasks:any[]}} */
const lookups = { projects: [], tasks: [] };

/** rows[i] = { id?, project_id, task_id, hours: number[7], note } */
let rows = [];
let submission = null; // submission row, if any
let clockHours = {};   // { "YYYY-MM-DD": hours }
let selectedMonday = mondayOf(new Date()); // current week
let overtimeThreshold = 40;

/* -------------------------------------------------------------- init */

document.getElementById("week-picker").value = isoDate(selectedMonday);
document.getElementById("week-picker").addEventListener("change", (e) => {
  const d = mondayOf(new Date(e.target.value));
  selectedMonday = d;
  document.getElementById("week-picker").value = isoDate(d);
  loadWeek();
});

document.getElementById("add-row").addEventListener("click", () => {
  rows.push(emptyRow());
  renderTable();
});

document.getElementById("save-draft").addEventListener("click", () => saveDraft({ notify: true }));
document.getElementById("submit-btn").addEventListener("click", submit);
document.getElementById("import-yes").addEventListener("click", doImportLastWeek);
document.getElementById("import-no").addEventListener("click", () => {
  document.getElementById("import-prompt").classList.add("hidden");
});

await loadLookups();
await loadWeek();

/* -------------------------------------------------------------- load */

async function loadLookups() {
  const [{ data: projects }, { data: tasks }, { data: settings }] = await Promise.all([
    supabase
      .from("projects")
      .select("id, job_number, project_number, job_description, project_description, active, job_status")
      .eq("active", true)
      .order("job_number")
      .order("project_number"),
    supabase.from("tasks").select("id, name, active").eq("active", true).order("name"),
    supabase.from("app_settings").select("overtime_threshold_hours").eq("id", 1).maybeSingle(),
  ]);
  lookups.projects = projects || [];
  lookups.tasks = tasks || [];
  if (settings?.overtime_threshold_hours) {
    overtimeThreshold = Number(settings.overtime_threshold_hours);
  }
  if (employee?.overtime_threshold_hours) {
    overtimeThreshold = Number(employee.overtime_threshold_hours);
  }
}

async function loadWeek() {
  clearStatus();
  const weekStart = isoDate(selectedMonday);

  const { data, error } = await supabase.rpc("load_timesheet_week", {
    p_week_start: weekStart,
  });
  if (error) {
    notice(error.message, "error");
    return;
  }

  submission = data?.submission || null;

  // Group entries into (project, task) rows with 7 daily hour slots.
  rows = [];
  const byKey = new Map();
  const days = weekDays(selectedMonday).map(isoDate);
  for (const e of data?.entries || []) {
    const key = `${e.project_id}::${e.task_id}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        id: e.id,
        project_id: e.project_id,
        task_id: e.task_id,
        hours: [0, 0, 0, 0, 0, 0, 0],
        note: e.note || "",
      });
    }
    const row = byKey.get(key);
    const idx = days.indexOf(e.work_date);
    if (idx >= 0) row.hours[idx] = Number(e.hours) || 0;
  }
  rows = Array.from(byKey.values());

  // Clock hours (pre-fill reference).
  clockHours = {};
  for (const c of data?.clock_hours || []) {
    clockHours[c.day] = Number(c.hours) || 0;
  }

  document.getElementById("employee-note").value = submission?.employee_note || "";

  updateStatusChip();
  renderDateRow();
  renderTable();
  renderClockRow();

  // Show rejection banner if applicable.
  const rej = document.getElementById("rejection-card");
  if (submission?.status === "rejected" && submission?.rejection_reason) {
    rej.style.display = "";
    document.getElementById("rejection-reason").textContent = submission.rejection_reason;
  } else {
    rej.style.display = "none";
  }

  // Show import prompt on an empty week.
  const promptEl = document.getElementById("import-prompt");
  if (rows.length === 0 && (!submission || submission.status === "draft")) {
    promptEl.classList.remove("hidden");
  } else {
    promptEl.classList.add("hidden");
  }
}

async function doImportLastWeek() {
  const { data, error } = await supabase.rpc("import_last_timesheet", {
    p_week_start: isoDate(selectedMonday),
  });
  if (error) {
    notice(error.message, "error");
    return;
  }
  notice(`Imported ${data} row${data === 1 ? "" : "s"} from last timesheet`, "success");
  document.getElementById("import-prompt").classList.add("hidden");
  await loadWeek();
}

/* -------------------------------------------------------------- render */

function renderDateRow() {
  const row = document.getElementById("day-date-row");
  // Keep the first <th>, rebuild the rest.
  row.innerHTML =
    `<th colspan="2" class="muted small text-right">Dates →</th>` +
    weekDays(selectedMonday)
      .map((d) => `<th class="muted small num">${formatShortDate(d)}</th>`)
      .join("") +
    `<th></th><th></th>`;
}

function renderTable() {
  const readOnly = submission && submission.status !== "draft" && submission.status !== "rejected";
  const body = document.getElementById("ts-body");
  body.innerHTML = "";

  if (rows.length === 0) {
    body.innerHTML = `
      <tr><td colspan="12" class="muted small" style="text-align:center;padding:24px">
        No rows yet. Click <strong>+ Add row</strong> or import last week's timesheet.
      </td></tr>`;
  }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const tr = document.createElement("tr");
    tr.dataset.idx = i;

    // Project selector
    const projTd = document.createElement("td");
    projTd.appendChild(renderProjectSelect(r, readOnly));
    tr.appendChild(projTd);

    // Task selector
    const taskTd = document.createElement("td");
    taskTd.appendChild(renderTaskSelect(r, readOnly));
    tr.appendChild(taskTd);

    // Day cells
    for (let d = 0; d < 7; d++) {
      const td = document.createElement("td");
      td.className = "num";
      const input = document.createElement("input");
      input.type = "number";
      input.step = "0.25";
      input.min = "0";
      input.max = "24";
      input.value = r.hours[d] > 0 ? r.hours[d] : "";
      input.disabled = readOnly;
      input.addEventListener("input", () => {
        r.hours[d] = clampHours(input.value);
        queueAutosave();
        updateTotals();
      });
      td.appendChild(input);

      // Weekend shading hint
      if (d >= 5) td.classList.add("overtime");
      tr.appendChild(td);
    }

    // Row total
    const totalTd = document.createElement("td");
    totalTd.className = "num";
    totalTd.dataset.rowTotal = i;
    totalTd.textContent = rowTotal(r).toFixed(2);
    tr.appendChild(totalTd);

    // Delete
    const delTd = document.createElement("td");
    if (!readOnly) {
      const btn = document.createElement("button");
      btn.className = "ghost small";
      btn.textContent = "✕";
      btn.title = "Remove row";
      btn.addEventListener("click", () => {
        rows.splice(i, 1);
        renderTable();
        queueAutosave();
      });
      delTd.appendChild(btn);
    }
    tr.appendChild(delTd);

    body.appendChild(tr);
  }

  updateTotals();
}

function renderProjectSelect(row, readOnly) {
  const sel = document.createElement("select");
  sel.disabled = readOnly;
  sel.innerHTML =
    `<option value="">— select project —</option>` +
    lookups.projects
      .map((p) => {
        const label = `${p.job_number} · ${p.project_number}${
          p.job_description ? " — " + p.job_description : ""
        }${p.job_status && p.job_status !== "Active" ? " (" + p.job_status + ")" : ""}`;
        const selected = row.project_id === p.id ? " selected" : "";
        return `<option value="${p.id}"${selected}>${escape(label)}</option>`;
      })
      .join("");
  sel.addEventListener("change", () => {
    row.project_id = sel.value ? Number(sel.value) : null;
    queueAutosave();
  });
  return sel;
}

function renderTaskSelect(row, readOnly) {
  const sel = document.createElement("select");
  sel.disabled = readOnly;
  sel.innerHTML =
    `<option value="">— select task —</option>` +
    lookups.tasks
      .map(
        (t) =>
          `<option value="${t.id}"${row.task_id === t.id ? " selected" : ""}>${escape(t.name)}</option>`
      )
      .join("");
  sel.addEventListener("change", () => {
    row.task_id = sel.value ? Number(sel.value) : null;
    queueAutosave();
  });
  return sel;
}

function renderClockRow() {
  const days = weekDays(selectedMonday);
  let total = 0;
  for (let d = 0; d < 7; d++) {
    const cell = document.querySelector(`[data-clock-total="${d}"]`);
    const hrs = clockHours[isoDate(days[d])] || 0;
    cell.textContent = hrs ? hrs.toFixed(2) : "—";
    total += hrs;
  }
  document.getElementById("clock-week-total").textContent = total > 0 ? total.toFixed(2) : "—";
}

/* -------------------------------------------------------------- totals */

function updateTotals() {
  const dayTotals = [0, 0, 0, 0, 0, 0, 0];
  for (const r of rows) {
    for (let d = 0; d < 7; d++) dayTotals[d] += r.hours[d] || 0;
  }

  // Row totals + OT shading
  let running = 0;
  const days = weekDays(selectedMonday).map(isoDate);
  // Recompute OT shading per cell.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const tr = document.querySelector(`tr[data-idx="${i}"]`);
    if (!tr) continue;
    const tds = tr.querySelectorAll("td.num");
    // first 7 num tds are days, 8th is row total
    for (let d = 0; d < 7; d++) {
      const cell = tds[d];
      const hrs = row.hours[d] || 0;
      running += hrs;
      const isWeekend = d >= 5;
      const isOT = isWeekend || running > overtimeThreshold;
      cell.classList.toggle("overtime", hrs > 0 && isOT);

      // Discrepancy: if entered hours for this day don't match clock hours.
      const clock = clockHours[days[d]] || 0;
      const entered = dayTotals[d];
      const off = Math.abs(entered - clock) > 0.25 && clock > 0;
      // discrepancy is a per-day-column thing — paint the daily-total cell below
      // individual row cells stay clean
    }
    const totalCell = tr.querySelector("[data-row-total]");
    if (totalCell) totalCell.textContent = rowTotal(row).toFixed(2);
  }

  // Daily totals + discrepancy highlight
  let weekTotal = 0;
  for (let d = 0; d < 7; d++) {
    weekTotal += dayTotals[d];
    const cell = document.querySelector(`[data-day-total="${d}"]`);
    cell.textContent = dayTotals[d].toFixed(2);
    const clock = clockHours[days[d]] || 0;
    const discrepant = clock > 0 && Math.abs(dayTotals[d] - clock) > 0.25;
    cell.classList.toggle("discrepancy", discrepant);
  }
  document.getElementById("week-total").textContent = weekTotal.toFixed(2);

  document.getElementById("totals-slot").innerHTML =
    `<strong>${weekTotal.toFixed(2)}h</strong> entered` +
    (weekTotal !== 40
      ? ` <span class="${weekTotal < 40 ? "muted" : ""}">(${
          weekTotal > 40 ? "+" : ""
        }${(weekTotal - 40).toFixed(2)} vs 40h target)</span>`
      : "");
}

function updateStatusChip() {
  const slot = document.getElementById("status-chip-slot");
  const status = submission?.status || "draft";
  slot.innerHTML = `<span class="chip ${status}">${statusLabel(status)}</span>`;

  const submitBtn = document.getElementById("submit-btn");
  const saveBtn = document.getElementById("save-draft");
  const addBtn = document.getElementById("add-row");
  const noteEl = document.getElementById("employee-note");

  const editable = !submission || submission.status === "draft" || submission.status === "rejected";
  submitBtn.disabled = !editable;
  saveBtn.disabled = !editable;
  addBtn.disabled = !editable;
  noteEl.disabled = !editable;
}

function statusLabel(s) {
  return (
    {
      draft: "Draft",
      submitted: "Submitted — awaiting manager",
      manager_approved: "Approved by manager",
      rejected: "Rejected",
      paid: "Paid",
    }[s] || s
  );
}

/* -------------------------------------------------------------- save */

let saveTimer = null;
function queueAutosave() {
  clearTimeout(saveTimer);
  setStatus("Unsaved changes…");
  saveTimer = setTimeout(() => saveDraft({ notify: false }), 1500);
}

async function saveDraft({ notify: showToast } = {}) {
  if (submission && submission.status !== "draft" && submission.status !== "rejected") return;

  // Guard: every row with hours must have project + task.
  for (const r of rows) {
    const total = rowTotal(r);
    if (total > 0 && (!r.project_id || !r.task_id)) {
      setStatus("");
      notice("Every row with hours needs a project and a task", "warn");
      return;
    }
  }

  const days = weekDays(selectedMonday).map(isoDate);
  const entries = [];
  for (const r of rows) {
    if (!r.project_id || !r.task_id) continue;
    for (let d = 0; d < 7; d++) {
      if (r.hours[d] > 0) {
        entries.push({
          project_id: r.project_id,
          task_id: r.task_id,
          work_date: days[d],
          hours: r.hours[d],
          note: r.note || null,
        });
      }
    }
  }

  setStatus("Saving…");
  const { error } = await supabase.rpc("save_timesheet_draft", {
    p_week_start: isoDate(selectedMonday),
    p_entries: entries,
    p_employee_note: document.getElementById("employee-note").value || null,
  });

  if (error) {
    setStatus("");
    notice(error.message, "error");
    return;
  }
  setStatus("Saved " + new Date().toLocaleTimeString());
  if (showToast) notice("Draft saved", "success");

  // refresh submission state (to pick up recomputed totals / is_overtime).
  const { data } = await supabase
    .from("timesheet_submissions")
    .select("*")
    .eq("user_id", employee.id)
    .eq("week_start", isoDate(selectedMonday))
    .maybeSingle();
  submission = data || submission;
  updateStatusChip();
}

async function submit() {
  const weekTotal = rows.reduce((sum, r) => sum + rowTotal(r), 0);
  if (weekTotal <= 0) {
    notice("Enter hours before submitting", "warn");
    return;
  }
  if (Math.abs(weekTotal - 40) > 0.001) {
    const msg =
      weekTotal < 40
        ? `You've entered ${weekTotal.toFixed(2)}h — that's ${(40 - weekTotal).toFixed(
            2
          )}h short of 40. Submit anyway?`
        : `You've entered ${weekTotal.toFixed(
            2
          )}h — that's ${(weekTotal - 40).toFixed(2)}h over 40. Submit anyway?`;
    if (!confirm(msg)) return;
  }

  await saveDraft({ notify: false });

  const { error } = await supabase.rpc("submit_timesheet", {
    p_week_start: isoDate(selectedMonday),
  });
  if (error) {
    notice(error.message, "error");
    return;
  }
  notice("Timesheet submitted to your manager", "success");
  await loadWeek();
}

/* -------------------------------------------------------------- helpers */

function emptyRow() {
  return { project_id: null, task_id: null, hours: [0, 0, 0, 0, 0, 0, 0], note: "" };
}

function rowTotal(r) {
  return r.hours.reduce((a, b) => a + (Number(b) || 0), 0);
}

function clampHours(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n > 24) return 24;
  return Math.round(n * 100) / 100;
}

function setStatus(msg) {
  document.getElementById("save-status").textContent = msg;
}
function clearStatus() {
  setStatus("");
}

function escape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
