// Temporium Staff page.
//
// Four tabs:
//   1. Employees     — list + add + edit + soft-delete
//   2. Departments   — CRUD for the department dropdown
//   3. Organisation  — department columns with drag-drop employee cards
//   4. Management    — manager columns with drag-drop department cards
//
// "Complete profile" (Unit 2 choice 1b): department_id + cost_rate +
// sell_rate + employment_type + employee_code. Incomplete profiles show a
// yellow "incomplete" chip + an inline warning listing what's missing.

import { getSupabase } from "/js/supabase-client.js";
import {
  notice,
  escapeHtml,
  renderTopbar,
  requireAdmin,
} from "/js/shared.js";

const sb = await getSupabase();
const ctx = await requireAdmin(sb);
let currentOrgId = ctx.currentOrgId;

renderTopbar({
  session: ctx.session,
  isDeveloper: ctx.isDeveloper,
  adminRow: ctx.adminRow,
  orgs: ctx.orgs,
  currentOrgId,
  onOrgChange: (id) => {
    currentOrgId = id;
    localStorage.setItem("temporium-dev-org-id", String(id));
    reloadAll();
  },
  active: "staff",
});

if (!currentOrgId) {
  notice("No organisation on this account — contact a developer.", "error", {
    sticky: true,
  });
}

/* ---------------------------------------------------------------- state */

let employees = [];    // rows loaded from public.users
let departments = [];  // { id, name, active, manager_id }
let filter = {
  search: "",
  showInactive: false,
  onlyIncomplete: false,
};
let activeTab = "employees";
let activeOrgView = "columns";
let editingDeptId = null;  // which department row is in edit mode, if any

/* ---------------------------------------------------------------- tabs */

// Outer tabs (Employees / Organisation) — selected by [data-tab] only.
// IMPORTANT: don't use `.tabs > .tab`; the sub-tabs (.tabs.sub) also match
// that selector, which caused "Reporting tree" clicks to collapse the whole
// panel because btn.dataset.tab was undefined.
document.querySelectorAll("[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-tab]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    activeTab = btn.dataset.tab;
    document.getElementById("tab-employees").style.display   = activeTab === "employees"   ? "" : "none";
    document.getElementById("tab-departments").style.display = activeTab === "departments" ? "" : "none";
    document.getElementById("tab-org").style.display         = activeTab === "org"         ? "" : "none";
    document.getElementById("tab-management").style.display  = activeTab === "management"  ? "" : "none";
    if (activeTab === "org")         renderOrg();
    if (activeTab === "departments") renderDepartments();
    if (activeTab === "management")  renderManagement();
  });
});

// Sub-tabs inside the Organisation panel (Departments view / Reporting tree).
document.querySelectorAll("[data-org-view]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-org-view]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    activeOrgView = btn.dataset.orgView;
    document.getElementById("org-columns").style.display = activeOrgView === "columns" ? "" : "none";
    document.getElementById("org-tree").style.display = activeOrgView === "tree" ? "" : "none";
    renderOrg();
  });
});

/* ---------------------------------------------------------------- filters */

document.getElementById("search-input").addEventListener("input", (e) => {
  filter.search = e.target.value.trim().toLowerCase();
  renderEmployees();
});
document.getElementById("show-inactive").addEventListener("change", (e) => {
  filter.showInactive = e.target.checked;
  renderEmployees();
});
document.getElementById("only-incomplete").addEventListener("change", (e) => {
  filter.onlyIncomplete = e.target.checked;
  renderEmployees();
});

document.getElementById("add-employee-btn").addEventListener("click", () => {
  if (!ctx.isAdminOrHigher) return notice("Admins only", "warn");
  openDialog(null);
});
if (!ctx.isAdminOrHigher) {
  document.getElementById("add-employee-btn").disabled = true;
}

/* ---------------------------------------------------------------- departments tab */

if (ctx.isAdminOrHigher) {
  document.getElementById("add-department").addEventListener("click", addDepartment);
  document
    .getElementById("new-department")
    .addEventListener("keydown", (e) => e.key === "Enter" && addDepartment());
} else {
  document.getElementById("add-department").disabled = true;
  document.getElementById("new-department").disabled = true;
}

/* ---------------------------------------------------------------- load */

await reloadAll();

async function reloadAll() {
  if (!currentOrgId) return;
  await Promise.all([loadDepartments(), loadEmployees()]);
  renderEmployees();
  if (activeTab === "departments") renderDepartments();
  if (activeTab === "org") renderOrg();
  if (activeTab === "management") renderManagement();
}

async function loadEmployees() {
  const { data, error } = await sb
    .from("users")
    .select(
      "id, name, email, department, department_id, employee_code, cost_rate, sell_rate, employment_type, overtime_threshold_hours, active, qr_token, organisation_id, is_manager"
    )
    .eq("organisation_id", currentOrgId)
    .order("name");
  if (error) {
    notice(`Couldn't load employees: ${error.message}`, "error", { sticky: true });
    employees = [];
    return;
  }
  employees = data || [];
}

async function loadDepartments() {
  const { data, error } = await sb
    .from("departments")
    .select("id, name, active, manager_id")
    .eq("organisation_id", currentOrgId)
    .order("name");
  if (error) {
    notice(`Couldn't load departments: ${error.message}`, "error", { sticky: true });
    departments = [];
    return;
  }
  departments = data || [];
}

/* ---------------------------------------------------------------- employees tab */

function missingFields(emp) {
  const missing = [];
  if (!emp.department_id) missing.push("department");
  if (emp.cost_rate == null) missing.push("cost rate");
  if (emp.sell_rate == null) missing.push("sell rate");
  if (!emp.employment_type) missing.push("employment type");
  if (!emp.employee_code || emp.employee_code.trim() === "") missing.push("employee code");
  return missing;
}

function deptName(id) {
  const d = departments.find((x) => x.id === id);
  return d ? d.name : "";
}

function renderEmployees() {
  const body = document.getElementById("staff-body");

  const rows = employees
    .filter((e) => (filter.showInactive ? true : e.active))
    .filter((e) => {
      if (!filter.search) return true;
      const hay = [e.name, e.email, e.employee_code].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(filter.search);
    })
    .filter((e) => (filter.onlyIncomplete ? missingFields(e).length > 0 : true));

  const incompleteCount = employees.filter(
    (e) => e.active && missingFields(e).length > 0
  ).length;

  document.getElementById("staff-summary").innerHTML =
    `${rows.length} shown · ${employees.filter((e) => e.active).length} active` +
    (incompleteCount
      ? ` · <span class="chip rejected" style="margin-left:4px">${incompleteCount} incomplete</span>`
      : "");

  if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="9" class="muted small" style="text-align:center;padding:16px">No employees match your filters.</td></tr>`;
    return;
  }

  body.innerHTML = rows
    .map((e) => {
      const miss = missingFields(e);
      const statusChip = !e.active
        ? `<span class="chip">Inactive</span>`
        : miss.length
          ? `<span class="chip missing" title="Missing: ${miss.join(", ")}">Incomplete</span>`
          : `<span class="chip manager_approved">Active</span>`;
      const deptCell = e.department_id
        ? escapeHtml(deptName(e.department_id))
        : e.department
          ? `<span class="muted small">${escapeHtml(e.department)} <em>(unlinked)</em></span>`
          : `<span class="muted small">—</span>`;
      return `
        <tr data-emp="${e.id}" class="${e.active ? "" : "muted"}">
          <td>${escapeHtml(e.name)}</td>
          <td class="small muted">${escapeHtml(e.email || "")}</td>
          <td>${deptCell}</td>
          <td class="small">${escapeHtml(e.employment_type || "")}</td>
          <td class="small muted">${escapeHtml(e.employee_code || "")}</td>
          <td class="num">${e.cost_rate != null ? Number(e.cost_rate).toFixed(2) : "<span class=\"muted\">—</span>"}</td>
          <td class="num">${e.sell_rate != null ? Number(e.sell_rate).toFixed(2) : "<span class=\"muted\">—</span>"}</td>
          <td>${statusChip}</td>
          <td><button class="ghost" data-edit="${e.id}">${ctx.isAdminOrHigher ? "Edit" : "View"}</button></td>
        </tr>`;
    })
    .join("");

  body.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => openDialog(Number(b.dataset.edit)))
  );
}

/* ---------------------------------------------------------------- departments tab render */

function renderDepartments() {
  const body = document.getElementById("departments-body");
  document.getElementById("dept-count").textContent =
    `${departments.length} department${departments.length === 1 ? "" : "s"}`;

  if (!departments.length) {
    body.innerHTML = `<tr><td colspan="3" class="muted small" style="text-align:center;padding:16px">No departments yet — ${ctx.isAdminOrHigher ? "add one above" : "an admin can add one"}.</td></tr>`;
    return;
  }

  body.innerHTML = departments
    .map((d) => {
      const isEditing = editingDeptId === d.id;
      const nameCell = isEditing
        ? `<input data-field="name" value="${escapeHtml(d.name)}" style="width:280px" />`
        : escapeHtml(d.name);
      const activeCell = isEditing
        ? `<input type="checkbox" data-field="active" ${d.active ? "checked" : ""} />`
        : d.active
          ? `<span class="small muted">Yes</span>`
          : `<span class="chip">Inactive</span>`;
      const actions = !ctx.isAdminOrHigher
        ? ""
        : isEditing
          ? `
              <button data-save-dept="${d.id}">Save</button>
              <button data-cancel-dept="${d.id}" class="ghost">Cancel</button>
              <button data-del-dept="${d.id}" class="danger">Delete</button>`
          : `<button data-edit-dept="${d.id}" class="ghost">Edit</button>`;
      return `
        <tr data-dept="${d.id}">
          <td>${nameCell}</td>
          <td>${activeCell}</td>
          <td class="row-flex">${actions}</td>
        </tr>`;
    })
    .join("");

  body.querySelectorAll("[data-edit-dept]").forEach((b) =>
    b.addEventListener("click", () => {
      editingDeptId = Number(b.dataset.editDept);
      renderDepartments();
    })
  );
  body.querySelectorAll("[data-cancel-dept]").forEach((b) =>
    b.addEventListener("click", () => {
      editingDeptId = null;
      renderDepartments();
    })
  );
  body.querySelectorAll("[data-save-dept]").forEach((b) =>
    b.addEventListener("click", () => saveDepartmentRow(Number(b.dataset.saveDept)))
  );
  body.querySelectorAll("[data-del-dept]").forEach((b) =>
    b.addEventListener("click", () => deleteDepartmentRow(Number(b.dataset.delDept)))
  );
}

async function addDepartment() {
  const input = document.getElementById("new-department");
  const name = input.value.trim();
  if (!name) return;
  if (!currentOrgId) return notice("No organisation selected", "error");

  const { error } = await sb
    .from("departments")
    .insert({ organisation_id: currentOrgId, name });
  if (error) return notice(error.message, "error");
  input.value = "";
  notice(`Added "${name}"`, "success");
  await reloadAll();
}

async function saveDepartmentRow(id) {
  const tr = document.querySelector(`tr[data-dept="${id}"]`);
  const name = tr.querySelector('[data-field="name"]').value.trim();
  const active = tr.querySelector('[data-field="active"]').checked;
  if (!name) return notice("Name required", "warn");

  const { error } = await sb
    .from("departments")
    .update({ name, active })
    .eq("id", id)
    .eq("organisation_id", currentOrgId);
  if (error) return notice(error.message, "error");
  notice("Saved", "success");
  editingDeptId = null;
  await reloadAll();
}

async function deleteDepartmentRow(id) {
  const d = departments.find((x) => x.id === id);
  const inUse = employees.some((e) => e.department_id === id);
  const msg = inUse
    ? `Delete "${d?.name}"? ${employees.filter((e) => e.department_id === id).length} employee(s) will be left unassigned.`
    : `Delete "${d?.name}"?`;
  if (!confirm(msg)) return;
  const { error } = await sb
    .from("departments")
    .delete()
    .eq("id", id)
    .eq("organisation_id", currentOrgId);
  if (error) return notice(error.message, "error");
  editingDeptId = null;
  await reloadAll();
}

/* ---------------------------------------------------------------- dialog */

function openDialog(empId) {
  const dialog = document.getElementById("employee-dialog");
  const isEdit = empId != null;
  const emp = isEdit ? employees.find((e) => e.id === empId) : null;

  document.getElementById("dialog-title").textContent = isEdit ? "Edit employee" : "Add employee";
  document.getElementById("f-name").value = emp?.name || "";
  document.getElementById("f-email").value = emp?.email || "";
  document.getElementById("f-code").value = emp?.employee_code || "";
  document.getElementById("f-employment").value = emp?.employment_type || "waged";
  document.getElementById("f-cost").value = emp?.cost_rate ?? "";
  document.getElementById("f-sell").value = emp?.sell_rate ?? "";
  document.getElementById("f-ot").value = emp?.overtime_threshold_hours ?? 40;
  document.getElementById("f-manager").checked = emp?.is_manager || false;

  const deptSel = document.getElementById("f-department");
  deptSel.innerHTML =
    `<option value="">—</option>` +
    departments
      .filter((d) => d.active)
      .map(
        (d) =>
          `<option value="${d.id}"${emp && emp.department_id === d.id ? " selected" : ""}>${escapeHtml(d.name)}</option>`
      )
      .join("");

  const deact = document.getElementById("deactivate-btn");
  if (isEdit && emp.active) {
    deact.classList.remove("hidden");
    deact.textContent = "Deactivate";
    deact.onclick = () => deactivateEmployee(emp.id);
  } else if (isEdit && !emp.active) {
    deact.classList.remove("hidden");
    deact.textContent = "Reactivate";
    deact.onclick = () => reactivateEmployee(emp.id);
  } else {
    deact.classList.add("hidden");
  }

  // Gate form controls for manager role.
  const form = document.getElementById("employee-form");
  form.querySelectorAll("input,select,button[type=submit]").forEach((el) => {
    el.disabled = !ctx.isAdminOrHigher;
  });
  document.getElementById("cancel-edit").disabled = false;

  form.dataset.empId = isEdit ? String(empId) : "";
  dialog.showModal();
}

document.getElementById("cancel-edit").addEventListener("click", () =>
  document.getElementById("employee-dialog").close()
);

document.getElementById("employee-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!ctx.isAdminOrHigher) return;

  const form = e.currentTarget;
  const payload = {
    name: document.getElementById("f-name").value.trim(),
    email: document.getElementById("f-email").value.trim() || null,
    department_id: document.getElementById("f-department").value
      ? Number(document.getElementById("f-department").value)
      : null,
    employment_type: document.getElementById("f-employment").value,
    employee_code: document.getElementById("f-code").value.trim() || null,
    cost_rate: document.getElementById("f-cost").value === "" ? null : Number(document.getElementById("f-cost").value),
    sell_rate: document.getElementById("f-sell").value === "" ? null : Number(document.getElementById("f-sell").value),
    overtime_threshold_hours:
      document.getElementById("f-ot").value === ""
        ? null
        : Number(document.getElementById("f-ot").value),
    is_manager: document.getElementById("f-manager").checked,
  };

  if (!payload.name) {
    notice("Name is required", "warn");
    return;
  }

  const empId = form.dataset.empId ? Number(form.dataset.empId) : null;

  if (empId) {
    // Update: keep department free-text in sync so existing Attendium views
    // that still read the text column stay meaningful.
    const updatePayload = { ...payload };
    if (payload.department_id) {
      const d = departments.find((x) => x.id === payload.department_id);
      updatePayload.department = d?.name || null;
    } else {
      updatePayload.department = null;
    }
    const { error } = await sb
      .from("users")
      .update(updatePayload)
      .eq("id", empId)
      .eq("organisation_id", currentOrgId);
    if (error) return notice(error.message, "error");
    notice("Saved", "success");
  } else {
    const { error } = await sb.rpc("create_employee", {
      p_org_id: currentOrgId,
      p_name: payload.name,
      p_email: payload.email,
      p_department_id: payload.department_id,
      p_cost_rate: payload.cost_rate,
      p_sell_rate: payload.sell_rate,
      p_employment_type: payload.employment_type,
      p_employee_code: payload.employee_code,
      p_overtime_threshold_hours: payload.overtime_threshold_hours,
    });
    if (error) return notice(error.message, "error");
    notice("Employee created", "success");
  }

  document.getElementById("employee-dialog").close();
  await reloadAll();
});

async function deactivateEmployee(id) {
  if (!confirm("Deactivate this employee? Their history will be kept.")) return;
  const { error } = await sb
    .from("users")
    .update({ active: false })
    .eq("id", id)
    .eq("organisation_id", currentOrgId);
  if (error) return notice(error.message, "error");
  document.getElementById("employee-dialog").close();
  notice("Deactivated", "success");
  await reloadAll();
}
async function reactivateEmployee(id) {
  const { error } = await sb
    .from("users")
    .update({ active: true })
    .eq("id", id)
    .eq("organisation_id", currentOrgId);
  if (error) return notice(error.message, "error");
  document.getElementById("employee-dialog").close();
  notice("Reactivated", "success");
  await reloadAll();
}

/* ---------------------------------------------------------------- organisation */

function renderOrg() {
  if (activeOrgView === "columns") {
    renderOrgColumns();
  } else {
    renderOrgTree();
  }
}

function renderOrgColumns() {
  const container = document.getElementById("org-columns");
  const active = employees.filter((e) => e.active);

  // Unassigned column
  const unassigned = active.filter((e) => !e.department_id);

  const columns = departments
    .filter((d) => d.active)
    .map((d) => {
      const members = active.filter((e) => e.department_id === d.id);
      const manager = d.manager_id ? active.find((e) => e.id === d.manager_id) : null;
      return `
        <div class="org-column" data-drop-dept="${d.id}">
          <div class="org-column-header">
            <div><strong>${escapeHtml(d.name)}</strong></div>
            <div class="small muted">${manager ? `Manager: ${escapeHtml(manager.name)}` : "No manager"}</div>
            <div class="small muted">${members.length} member${members.length === 1 ? "" : "s"}</div>
          </div>
          <div class="org-column-body">
            ${members.map((m) => cardHtml(m, d.manager_id === m.id)).join("")}
          </div>
        </div>`;
    })
    .join("");

  const unassignedCol = `
    <div class="org-column org-column-unassigned" data-drop-dept="">
      <div class="org-column-header">
        <div><strong>Unassigned</strong></div>
        <div class="small muted">${unassigned.length} member${unassigned.length === 1 ? "" : "s"}</div>
      </div>
      <div class="org-column-body">
        ${unassigned.map((m) => cardHtml(m, false)).join("")}
      </div>
    </div>`;

  container.innerHTML = columns + unassignedCol;

  if (ctx.isAdminOrHigher) {
    wireDragDrop();
  }
}

function cardHtml(emp, isManager) {
  const miss = missingFields(emp);
  return `
    <div class="org-card ${miss.length ? "incomplete" : ""} ${isManager ? "is-manager" : ""}"
         draggable="${ctx.isAdminOrHigher ? "true" : "false"}"
         data-emp-id="${emp.id}">
      <div class="org-card-name">${escapeHtml(emp.name)}${isManager ? ' <span class="small muted">· manager</span>' : ""}</div>
      <div class="small muted">${escapeHtml(emp.employment_type || "")}${emp.employee_code ? " · " + escapeHtml(emp.employee_code) : ""}</div>
      ${miss.length ? `<div class="small warn-text">Missing: ${miss.join(", ")}</div>` : ""}
    </div>`;
}

function wireDragDrop() {
  const cards = document.querySelectorAll(".org-card");
  const cols = document.querySelectorAll("[data-drop-dept]");

  cards.forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/emp", card.dataset.empId);
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  });

  cols.forEach((col) => {
    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      col.classList.add("drop-hover");
    });
    col.addEventListener("dragleave", () => col.classList.remove("drop-hover"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault();
      col.classList.remove("drop-hover");
      const empId = Number(e.dataTransfer.getData("text/emp"));
      const deptId = col.dataset.dropDept ? Number(col.dataset.dropDept) : null;
      if (!empId) return;
      const emp = employees.find((x) => x.id === empId);
      if (!emp) return;
      if (emp.department_id === deptId) return; // no-op

      // Optimistic: update locally, then persist.
      const deptRow = departments.find((d) => d.id === deptId);
      const patch = {
        department_id: deptId,
        department: deptRow?.name ?? null,
      };
      const { error } = await sb
        .from("users")
        .update(patch)
        .eq("id", empId)
        .eq("organisation_id", currentOrgId);
      if (error) {
        notice(error.message, "error");
        return;
      }

      // If the employee was the old department's manager, clear that.
      const oldDept = departments.find((d) => d.manager_id === empId);
      if (oldDept && oldDept.id !== deptId) {
        await sb
          .from("departments")
          .update({ manager_id: null })
          .eq("id", oldDept.id)
          .eq("organisation_id", currentOrgId);
      }

      await reloadAll();
      notice(`Moved ${emp.name}${deptRow ? ` to ${deptRow.name}` : " to Unassigned"}`, "success");
    });
  });
}

function renderOrgTree() {
  const container = document.getElementById("org-tree");
  const active = employees.filter((e) => e.active);

  // Build nodes keyed by manager. The "tree" is really a set of trees rooted
  // at each department's manager.
  const managers = departments
    .filter((d) => d.active && d.manager_id)
    .map((d) => ({
      dept: d,
      manager: active.find((e) => e.id === d.manager_id),
      reports: active.filter((e) => e.department_id === d.id && e.id !== d.manager_id),
    }))
    .filter((n) => n.manager);

  const deptless = active.filter(
    (e) => !e.department_id && !departments.some((d) => d.manager_id === e.id)
  );

  if (managers.length === 0 && deptless.length === 0) {
    container.innerHTML = `<p class="muted small">No managers assigned yet. Pick one in the Departments view.</p>`;
    return;
  }

  container.innerHTML =
    managers
      .map(
        (n) => `
      <div class="org-tree-node">
        <div class="org-tree-manager">
          <strong>${escapeHtml(n.manager.name)}</strong>
          <span class="small muted">· manages ${escapeHtml(n.dept.name)} (${n.reports.length})</span>
        </div>
        <div class="org-tree-reports">
          ${
            n.reports.length === 0
              ? '<div class="small muted">No direct reports yet.</div>'
              : n.reports
                  .map(
                    (r) => `
                <div class="org-tree-report">
                  ${escapeHtml(r.name)}
                  <span class="small muted">${escapeHtml(r.employment_type || "")}</span>
                </div>`
                  )
                  .join("")
          }
        </div>
      </div>`
      )
      .join("") +
    (deptless.length
      ? `<div class="org-tree-node">
          <div class="org-tree-manager"><strong>Unassigned</strong>
            <span class="small muted">· ${deptless.length} without a department</span>
          </div>
          <div class="org-tree-reports">
            ${deptless.map((e) => `<div class="org-tree-report">${escapeHtml(e.name)}</div>`).join("")}
          </div>
        </div>`
      : "");
}

/* ---------------------------------------------------------------- management tab */

function renderManagement() {
  const container = document.getElementById("mgmt-columns");
  const managers = employees.filter((e) => e.active && e.is_manager);
  const activeDepts = departments.filter((d) => d.active);

  if (managers.length === 0) {
    container.innerHTML = `
      <p class="muted small">
        No managers yet. Edit an employee's profile and check the
        <strong>Manager</strong> box to make them available here.
      </p>`;
    return;
  }

  const deptCardHtml = (d) => {
    const memberCount = employees.filter((e) => e.active && e.department_id === d.id).length;
    return `
      <div class="org-card" draggable="${ctx.isAdminOrHigher ? "true" : "false"}"
           data-dept-card="${d.id}">
        <div class="org-card-name">${escapeHtml(d.name)}</div>
        <div class="small muted">${memberCount} member${memberCount === 1 ? "" : "s"}</div>
      </div>`;
  };

  const managerCols = managers
    .map((m) => {
      const theirDepts = activeDepts.filter((d) => d.manager_id === m.id);
      return `
        <div class="org-column" data-drop-mgr="${m.id}">
          <div class="org-column-header">
            <div><strong>${escapeHtml(m.name)}</strong></div>
            <div class="small muted">${theirDepts.length} department${theirDepts.length === 1 ? "" : "s"}</div>
          </div>
          <div class="org-column-body">
            ${theirDepts.map(deptCardHtml).join("") || '<div class="small muted" style="padding:8px">No departments assigned.</div>'}
          </div>
        </div>`;
    })
    .join("");

  const unmanaged = activeDepts.filter(
    (d) => !d.manager_id || !managers.some((m) => m.id === d.manager_id)
  );

  const unmanagedCol = `
    <div class="org-column org-column-unassigned" data-drop-mgr="">
      <div class="org-column-header">
        <div><strong>Unmanaged</strong></div>
        <div class="small muted">${unmanaged.length} department${unmanaged.length === 1 ? "" : "s"}</div>
      </div>
      <div class="org-column-body">
        ${unmanaged.map(deptCardHtml).join("") || '<div class="small muted" style="padding:8px">All departments assigned.</div>'}
      </div>
    </div>`;

  container.innerHTML = managerCols + unmanagedCol;

  if (ctx.isAdminOrHigher) {
    wireMgmtDragDrop();
  }
}

function wireMgmtDragDrop() {
  const cards = document.querySelectorAll("[data-dept-card]");
  const cols = document.querySelectorAll("[data-drop-mgr]");

  cards.forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/dept", card.dataset.deptCard);
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  });

  cols.forEach((col) => {
    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      col.classList.add("drop-hover");
    });
    col.addEventListener("dragleave", () => col.classList.remove("drop-hover"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault();
      col.classList.remove("drop-hover");
      const deptId = Number(e.dataTransfer.getData("text/dept"));
      const managerId = col.dataset.dropMgr ? Number(col.dataset.dropMgr) : null;
      if (!deptId) return;

      const dept = departments.find((d) => d.id === deptId);
      if (!dept) return;
      if (dept.manager_id === managerId) return;

      const { error } = await sb
        .from("departments")
        .update({ manager_id: managerId })
        .eq("id", deptId)
        .eq("organisation_id", currentOrgId);

      if (error) return notice(error.message, "error");

      const mgrName = managerId
        ? employees.find((m) => m.id === managerId)?.name || "manager"
        : "Unmanaged";
      notice(`Moved ${dept.name} to ${mgrName}`, "success");
      await loadDepartments();
      renderManagement();
    });
  });
}
