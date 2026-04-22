// PTL Timesheet — weekly timesheet grid.

import { getSupabase } from "/js/supabase-client.js";
import { notice, escapeHtml, renderTopbar } from "/js/shared.js";

const sb = await getSupabase();

/* ---------------------------------------------------------------- auth */

const { data: { session } } = await sb.auth.getSession();
if (!session) { location.replace("/signin.html"); throw new Error("not signed in"); }

let employee = null;
let isDeveloper = false;
let adminRow = null;
try { const r = await sb.rpc("is_developer"); isDeveloper = !!r.data; } catch {}
try {
  const r = await sb.from("admins").select("organisation_id, role").eq("user_id", session.user.id).maybeSingle();
  adminRow = r.data;
} catch {}
try {
  const r = await sb.from("users").select("id, organisation_id, name").eq("auth_user_id", session.user.id).maybeSingle();
  employee = r.data;
} catch {}

if (!employee) {
  location.replace("/welcome.html");
  throw new Error("no employee record");
}

const currentOrgId = employee.organisation_id;

renderTopbar({
  session,
  isDeveloper,
  adminRow,
  orgs: null,
  currentOrgId,
  onOrgChange: () => {},
  active: "timesheet",
});

/* ---------------------------------------------------------------- state */

const DAYS = ["mon","tue","wed","thu","fri","sat","sun"];
const DAY_LABELS = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];

let weekStart = getMonday(new Date());

// Support ?week=2026-04-20 from archive links
const urlWeek = new URLSearchParams(location.search).get("week");
if (urlWeek) {
  const parsed = new Date(urlWeek + "T00:00:00");
  if (!isNaN(parsed)) weekStart = getMonday(parsed);
}
let timesheetId = null;
let entries = [];
let jobs = [];
let tasks = [];

function getMonday(d) {
  const dt = new Date(d);
  const day = dt.getDay();
  const diff = dt.getDate() - day + (day === 0 ? -6 : 1);
  dt.setDate(diff);
  dt.setHours(0, 0, 0, 0);
  return dt;
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function fmtShortDate(d) {
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function weekLabel() {
  const end = addDays(weekStart, 6);
  const opts = { day: "numeric", month: "short" };
  return `${weekStart.toLocaleDateString(undefined, opts)} — ${end.toLocaleDateString(undefined, opts)}, ${end.getFullYear()}`;
}

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
      .eq("status", "ACTIVE")
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
}

/* ---------------------------------------------------------------- load timesheet */

async function loadWeek() {
  document.getElementById("week-label").textContent = weekLabel();

  // Render date headers
  const dateRow = document.getElementById("date-row");
  dateRow.innerHTML = `<td colspan="3"></td>` +
    DAYS.map((_, i) => `<td class="day-col">${fmtShortDate(addDays(weekStart, i))}</td>`).join("") +
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

  // Load status
  try {
    const { data } = await sb.from("timesheets").select("status").eq("id", timesheetId).maybeSingle();
    document.getElementById("ts-status").textContent = data?.status ? `Status: ${data.status}` : "";
  } catch {}

  // Load entries
  try {
    const { data, error } = await sb
      .from("timesheet_entries")
      .select("id, job_id, task_id, description, sort_order, mon_hours, tue_hours, wed_hours, thu_hours, fri_hours, sat_hours, sun_hours")
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

/* ---------------------------------------------------------------- render */

function renderGrid() {
  const body = document.getElementById("ts-body");

  if (!entries.length) {
    body.innerHTML = `<tr><td colspan="12" class="muted small" style="text-align:center">No tasks yet — click "+ Add task" to start.</td></tr>`;
    updateTotals();
    return;
  }

  body.innerHTML = entries.map((e, idx) => {
    const job = jobs.find((j) => j.id === e.job_id);
    const task = tasks.find((t) => t.id === e.task_id);
    const rowTotal = DAYS.reduce((sum, d) => sum + Number(e[`${d}_hours`] || 0), 0);

    return `
      <tr data-entry-id="${e.id}" data-idx="${idx}">
        <td>
          <select class="job-select" style="width:100%">
            <option value="">(select job)</option>
            ${jobs.map((j) =>
              `<option value="${j.id}"${j.id === e.job_id ? " selected" : ""}>${escapeHtml(j.job_code)}</option>`
            ).join("")}
          </select>
        </td>
        <td>
          <select class="task-select" style="width:100%">
            <option value="">(none)</option>
            ${tasks.map((t) =>
              `<option value="${t.id}"${t.id === e.task_id ? " selected" : ""}>${escapeHtml(t.task_code)}</option>`
            ).join("")}
          </select>
        </td>
        <td>
          <input class="desc-input" value="${escapeHtml(e.description || "")}" placeholder="Description…" style="width:100%" />
        </td>
        ${DAYS.map((d) => `
          <td class="day-col">
            <input type="number" class="hours-input" data-day="${d}"
              value="${Number(e[`${d}_hours`]) || ""}" min="0" max="24" step="0.25"
              style="width:56px;text-align:center" />
          </td>
        `).join("")}
        <td class="day-col row-total"><strong>${rowTotal}</strong></td>
        <td>
          <button class="ghost small delete-entry-btn" title="Remove row">✕</button>
        </td>
      </tr>
    `;
  }).join("");

  // Event listeners
  body.querySelectorAll(".job-select").forEach((sel) => {
    sel.addEventListener("change", (e) => {
      const row = e.target.closest("tr");
      const idx = Number(row.dataset.idx);
      entries[idx].job_id = sel.value ? Number(sel.value) : null;
      saveEntry(entries[idx]);
    });
  });

  body.querySelectorAll(".task-select").forEach((sel) => {
    sel.addEventListener("change", (e) => {
      const row = e.target.closest("tr");
      const idx = Number(row.dataset.idx);
      entries[idx].task_id = sel.value ? Number(sel.value) : null;
      saveEntry(entries[idx]);
    });
  });

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

  body.querySelectorAll(".hours-input").forEach((inp) => {
    let timer;
    inp.addEventListener("input", (e) => {
      const row = e.target.closest("tr");
      const idx = Number(row.dataset.idx);
      const day = inp.dataset.day;
      const val = parseFloat(inp.value) || 0;
      entries[idx][`${day}_hours`] = val;

      // Update row total
      const rowTotal = DAYS.reduce((sum, d) => sum + Number(entries[idx][`${d}_hours`] || 0), 0);
      row.querySelector(".row-total strong").textContent = rowTotal;
      updateTotals();

      clearTimeout(timer);
      timer = setTimeout(() => saveEntry(entries[idx]), 400);
    });
  });

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
    description: entry.description || null,
  };
  for (const d of DAYS) {
    update[`${d}_hours`] = Number(entry[`${d}_hours`]) || 0;
  }

  try {
    const { error } = await sb
      .from("timesheet_entries")
      .update(update)
      .eq("id", entry.id);
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

/* ---------------------------------------------------------------- week navigation */

document.getElementById("prev-week").addEventListener("click", () => {
  weekStart = addDays(weekStart, -7);
  loadWeek();
});
document.getElementById("next-week").addEventListener("click", () => {
  weekStart = addDays(weekStart, 7);
  loadWeek();
});

/* ---------------------------------------------------------------- boot */

await loadLookups();
await loadWeek();
