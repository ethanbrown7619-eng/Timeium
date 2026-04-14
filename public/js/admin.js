// Admin page. Controls:
//   - Weekly report exports (Infusion + IMS) as CSV
//   - Employees + rates (cost / sell). Rate changes append to wage_rate_history.
//   - Departments, tasks, holidays CRUD
//   - Projects list (synced from Infusion by the edge function)
//
// Kept in one file so the patterns are easy to compare.

import {
  requireAuth,
  renderTopbar,
  mondayOf,
  isoDate,
  buildCsv,
  downloadCsv,
  notice,
  escapeHtml,
  formatLongDate,
} from "/js/shared.js";

const ctx = await requireAuth({ requireAdmin: true });
renderTopbar(ctx, "admin");
const sb = ctx.supabase;

document.getElementById("report-week").value = isoDate(mondayOf(new Date()));

document.getElementById("export-infusion").addEventListener("click", exportInfusion);
document.getElementById("export-ims").addEventListener("click", exportIms);

document.getElementById("add-department").addEventListener("click", addDepartment);
document.getElementById("add-task").addEventListener("click", addTask);
document.getElementById("add-holiday").addEventListener("click", addHoliday);
document.getElementById("sync-projects").addEventListener("click", syncProjects);

await Promise.all([loadEmployees(), loadDepartments(), loadTasks(), loadHolidays(), loadProjects()]);

/* -------------------------------------------------------------- reports */

async function exportInfusion() {
  const week = document.getElementById("report-week").value;
  const { data, error } = await sb.rpc("infusion_report", { p_week_start: week });
  if (error) return notice(error.message, "error");
  if (!data || data.length === 0) return notice("No approved entries for that week", "warn");

  const cols = [
    "work_date", "job_number", "project_number", "job_description",
    "user_name", "employee_code", "task_name",
    "hours", "is_overtime", "cost_rate", "sell_rate", "cost_amount", "sell_amount",
  ];
  downloadCsv(`infusion-${week}.csv`, buildCsv(cols, data));
}

async function exportIms() {
  const week = document.getElementById("report-week").value;
  const { data, error } = await sb.rpc("ims_report", { p_week_start: week });
  if (error) return notice(error.message, "error");
  if (!data || data.length === 0) return notice("No waged approved timesheets that week", "warn");

  const cols = [
    "employee_code", "user_name", "department",
    "regular_hours", "overtime_hours", "total_hours", "status",
  ];
  downloadCsv(`ims-${week}.csv`, buildCsv(cols, data));
}

/* -------------------------------------------------------------- employees */

async function loadEmployees() {
  const [{ data: users }, { data: managers }] = await Promise.all([
    sb.from("users").select("*").order("name"),
    sb.from("users").select("id, name").eq("active", true).order("name"),
  ]);
  const body = document.getElementById("employees-body");
  if (!users) return (body.innerHTML = `<tr><td colspan="9" class="muted">No users yet.</td></tr>`);

  const managerOpts = (selected) =>
    `<option value="">—</option>` +
    managers
      .map((m) => `<option value="${m.id}"${m.id === selected ? " selected" : ""}>${escapeHtml(m.name)}</option>`)
      .join("");

  body.innerHTML = users
    .map(
      (u) => `
      <tr data-user="${u.id}">
        <td>${escapeHtml(u.name)}</td>
        <td><input data-field="employee_code" value="${escapeHtml(u.employee_code || "")}" style="width:80px" /></td>
        <td><input data-field="department" value="${escapeHtml(u.department || "")}" style="width:120px" /></td>
        <td>
          <select data-field="employment_type">
            <option value="waged"${u.employment_type === "waged" ? " selected" : ""}>Waged</option>
            <option value="salaried"${u.employment_type === "salaried" ? " selected" : ""}>Salaried</option>
            <option value="contractor"${u.employment_type === "contractor" ? " selected" : ""}>Contractor</option>
          </select>
        </td>
        <td><select data-field="manager_id">${managerOpts(u.manager_id)}</select></td>
        <td class="num"><input type="number" step="0.01" data-field="cost_rate" value="${u.cost_rate ?? ""}" style="width:80px" /></td>
        <td class="num"><input type="number" step="0.01" data-field="sell_rate" value="${u.sell_rate ?? ""}" style="width:80px" /></td>
        <td><input type="checkbox" data-field="active" ${u.active ? "checked" : ""} /></td>
        <td><button data-save="${u.id}">Save</button></td>
      </tr>`
    )
    .join("");

  body.querySelectorAll("[data-save]").forEach((btn) =>
    btn.addEventListener("click", () => saveEmployee(Number(btn.dataset.save)))
  );
}

async function saveEmployee(id) {
  const tr = document.querySelector(`tr[data-user="${id}"]`);
  const patch = {};
  tr.querySelectorAll("[data-field]").forEach((el) => {
    const f = el.dataset.field;
    let v = el.type === "checkbox" ? el.checked : el.value;
    if (f === "cost_rate" || f === "sell_rate") v = v === "" ? null : Number(v);
    if (f === "manager_id") v = v === "" ? null : Number(v);
    if (f === "employee_code" || f === "department") v = v.trim() || null;
    patch[f] = v;
  });

  // Fetch current rates to see if they changed (for wage_rate_history).
  const { data: before } = await sb.from("users").select("cost_rate, sell_rate").eq("id", id).maybeSingle();
  const rateChanged =
    before &&
    (Number(before.cost_rate ?? -1) !== Number(patch.cost_rate ?? -1) ||
      Number(before.sell_rate ?? -1) !== Number(patch.sell_rate ?? -1));

  const { error } = await sb.from("users").update(patch).eq("id", id);
  if (error) return notice(error.message, "error");

  if (rateChanged) {
    const today = isoDate(new Date());
    await sb.from("wage_rate_history").insert({
      user_id: id,
      cost_rate: patch.cost_rate,
      sell_rate: patch.sell_rate,
      effective_from: today,
    });
  }

  notice("Saved" + (rateChanged ? " (rate change recorded)" : ""), "success");
}

/* -------------------------------------------------------------- departments */

async function loadDepartments() {
  const { data } = await sb.from("departments").select("*").order("name");
  const body = document.getElementById("departments-body");
  body.innerHTML = (data || [])
    .map(
      (d) => `
      <tr data-dept="${d.id}">
        <td><input value="${escapeHtml(d.name)}" data-field="name" /></td>
        <td><input type="checkbox" data-field="active" ${d.active ? "checked" : ""} /></td>
        <td>
          <button data-save-dept="${d.id}" class="ghost">Save</button>
          <button data-del-dept="${d.id}" class="danger">Delete</button>
        </td>
      </tr>`
    )
    .join("");
  body.querySelectorAll("[data-save-dept]").forEach((b) =>
    b.addEventListener("click", async () => {
      const id = Number(b.dataset.saveDept);
      const tr = document.querySelector(`tr[data-dept="${id}"]`);
      const name = tr.querySelector('[data-field="name"]').value.trim();
      const active = tr.querySelector('[data-field="active"]').checked;
      const { error } = await sb.from("departments").update({ name, active }).eq("id", id);
      if (error) return notice(error.message, "error");
      notice("Saved", "success");
    })
  );
  body.querySelectorAll("[data-del-dept]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Delete this department?")) return;
      const { error } = await sb.from("departments").delete().eq("id", Number(b.dataset.delDept));
      if (error) return notice(error.message, "error");
      loadDepartments();
    })
  );
}

async function addDepartment() {
  const name = document.getElementById("new-department").value.trim();
  if (!name) return;
  const { error } = await sb.from("departments").insert({ name });
  if (error) return notice(error.message, "error");
  document.getElementById("new-department").value = "";
  loadDepartments();
}

/* -------------------------------------------------------------- tasks */

async function loadTasks() {
  const { data } = await sb.from("tasks").select("*").order("name");
  const body = document.getElementById("tasks-body");
  body.innerHTML = (data || [])
    .map(
      (t) => `
      <tr data-task="${t.id}">
        <td><input value="${escapeHtml(t.code || "")}" data-field="code" style="width:100px" /></td>
        <td><input value="${escapeHtml(t.name)}" data-field="name" /></td>
        <td><input type="checkbox" data-field="active" ${t.active ? "checked" : ""} /></td>
        <td>
          <button data-save-task="${t.id}" class="ghost">Save</button>
          <button data-del-task="${t.id}" class="danger">Delete</button>
        </td>
      </tr>`
    )
    .join("");
  body.querySelectorAll("[data-save-task]").forEach((b) =>
    b.addEventListener("click", async () => {
      const id = Number(b.dataset.saveTask);
      const tr = document.querySelector(`tr[data-task="${id}"]`);
      const code = tr.querySelector('[data-field="code"]').value.trim() || null;
      const name = tr.querySelector('[data-field="name"]').value.trim();
      const active = tr.querySelector('[data-field="active"]').checked;
      const { error } = await sb.from("tasks").update({ code, name, active }).eq("id", id);
      if (error) return notice(error.message, "error");
      notice("Saved", "success");
    })
  );
  body.querySelectorAll("[data-del-task]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Delete this task?")) return;
      const { error } = await sb.from("tasks").delete().eq("id", Number(b.dataset.delTask));
      if (error) return notice(error.message, "error");
      loadTasks();
    })
  );
}

async function addTask() {
  const name = document.getElementById("new-task-name").value.trim();
  const code = document.getElementById("new-task-code").value.trim() || null;
  if (!name) return;
  const { error } = await sb.from("tasks").insert({ name, code });
  if (error) return notice(error.message, "error");
  document.getElementById("new-task-name").value = "";
  document.getElementById("new-task-code").value = "";
  loadTasks();
}

/* -------------------------------------------------------------- holidays */

async function loadHolidays() {
  const { data } = await sb.from("holidays").select("*").order("holiday_date");
  const body = document.getElementById("holidays-body");
  body.innerHTML = (data || [])
    .map(
      (h) => `
      <tr>
        <td>${formatLongDate(h.holiday_date)}</td>
        <td>${escapeHtml(h.name)}</td>
        <td><button data-del-hol="${h.id}" class="danger">Delete</button></td>
      </tr>`
    )
    .join("");
  body.querySelectorAll("[data-del-hol]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Delete this holiday?")) return;
      const { error } = await sb.from("holidays").delete().eq("id", Number(b.dataset.delHol));
      if (error) return notice(error.message, "error");
      loadHolidays();
    })
  );
}

async function addHoliday() {
  const date = document.getElementById("new-holiday-date").value;
  const name = document.getElementById("new-holiday-name").value.trim();
  if (!date || !name) return notice("Date and name required", "warn");
  const { error } = await sb.from("holidays").insert({ holiday_date: date, name });
  if (error) return notice(error.message, "error");
  document.getElementById("new-holiday-date").value = "";
  document.getElementById("new-holiday-name").value = "";
  loadHolidays();
}

/* -------------------------------------------------------------- projects */

async function loadProjects() {
  const { data } = await sb
    .from("projects")
    .select("*")
    .order("job_number")
    .order("project_number")
    .limit(500);
  const body = document.getElementById("projects-body");
  body.innerHTML = (data || [])
    .map(
      (p) => `
      <tr>
        <td>${escapeHtml(p.job_number)}</td>
        <td>${escapeHtml(p.project_number)}</td>
        <td>${escapeHtml(p.job_description || "")}</td>
        <td>${escapeHtml(p.job_status || "")}</td>
        <td class="small muted">${escapeHtml(p.client_name || "")}</td>
        <td>${p.active ? "Yes" : "No"}</td>
        <td class="small muted">${p.last_synced_at ? new Date(p.last_synced_at).toLocaleString() : "—"}</td>
      </tr>`
    )
    .join("");

  const latest = (data || []).reduce((acc, p) => {
    if (!p.last_synced_at) return acc;
    return !acc || p.last_synced_at > acc ? p.last_synced_at : acc;
  }, null);
  document.getElementById("projects-meta").textContent = latest
    ? `Last sync: ${new Date(latest).toLocaleString()} · ${data.length} projects`
    : `No sync yet · ${(data || []).length} projects`;
}

async function syncProjects() {
  // Triggers the Supabase edge function. The function is responsible for
  // fetching from Infusion and calling upsert_projects_from_infusion.
  notice("Triggering Infusion sync…", "info");
  try {
    const { data, error } = await sb.functions.invoke("sync-infusion-projects");
    if (error) throw error;
    notice(`Sync complete — ${data?.count ?? "?"} projects upserted`, "success");
    loadProjects();
  } catch (e) {
    notice(
      "Sync failed: " +
        (e?.message ||
          "Edge function may not be deployed yet. See supabase/functions/sync-infusion-projects/README.md"),
      "error"
    );
  }
}
