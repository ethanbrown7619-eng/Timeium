// PTL Timesheet Staff page.
//
// Tabs:
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
  debounce,
  confirmDialog,
  promptDialog,
  getMonday,
  getActiveMonday,
  fmtDate,
  clearUserContextCache,
  invalidateWeekDashboard,
} from "/js/shared.js";

const sb = await getSupabase();
const ctx = await requireAdmin(sb);
let currentOrgId = ctx.currentOrgId;

renderTopbar({
  session: ctx.session,
  isDeveloper: ctx.isDeveloper,
  isManager: ctx.isManager,
  isClockViewer: ctx.isClockViewer,
  adminRow: ctx.adminRow,
  orgs: ctx.orgs,
  currentOrgId,
  onOrgChange: (id) => {
    currentOrgId = id;
    localStorage.setItem("ptl-dev-org-id", String(id));
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
let deptById = new Map();
function rebuildDeptById() {
  deptById = new Map(departments.map((d) => [d.id, d]));
}
function populateDepartmentFilter() {
  const sel = document.getElementById("filter-department");
  if (!sel) return;
  const previous = sel.value;
  const options = ['<option value="">All departments</option>']
    .concat(
      departments
        .filter((d) => d.active)
        .map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`),
    )
    .concat('<option value="__none">No department</option>');
  sel.innerHTML = options.join("");
  if (previous && [...sel.options].some((o) => o.value === previous)) {
    sel.value = previous;
  }
}
let adminUserIds = new Set();
let filter = {
  search: "",
  showInactive: true,
  onlyIncomplete: false,
  departmentId: "",
  employmentType: "",
  role: "",
};
let activeTab = "employees";
let activeOrgView = "columns";

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
    document.getElementById("tab-hierarchy").style.display   = activeTab === "hierarchy"   ? "" : "none";
    if (activeTab === "hierarchy")   renderHierarchy();
    if (activeTab === "departments") renderDepartments();
  });
});

// Sub-tabs inside the Hierarchy panel: Departments view / Reporting tree
// (both Organisation content) + Manager assignments (the old Management
// tab, folded in here).
document.querySelectorAll("[data-org-view]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-org-view]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    activeOrgView = btn.dataset.orgView;
    document.getElementById("org-columns").style.display = activeOrgView === "columns" ? "" : "none";
    document.getElementById("org-tree").style.display    = activeOrgView === "tree" ? "" : "none";
    document.getElementById("mgmt-columns").style.display = activeOrgView === "management" ? "" : "none";
    const hint = document.getElementById("hierarchy-hint");
    if (hint) {
      hint.innerHTML = activeOrgView === "management"
        ? `Drag department cards between managers to reassign them. To make someone a manager, edit their employee profile and check the <strong>Manager</strong> box.`
        : `Drag employee cards between departments to reassign them. Set each department's manager from its header dropdown.`;
    }
    renderHierarchy();
  });
});

// Render whichever Hierarchy sub-view is active.
function renderHierarchy() {
  if (activeOrgView === "management") renderManagement();
  else renderOrg();
}

/* ---------------------------------------------------------------- filters */

const handleSearchInput = debounce((value) => {
  filter.search = value.trim().toLowerCase();
  renderEmployees();
}, 150);
document.getElementById("search-input").addEventListener("input", (e) => {
  handleSearchInput(e.target.value);
});
document.getElementById("show-inactive").addEventListener("change", (e) => {
  filter.showInactive = e.target.checked;
  renderEmployees();
});
document.getElementById("only-incomplete").addEventListener("change", (e) => {
  filter.onlyIncomplete = e.target.checked;
  renderEmployees();
});
document.getElementById("filter-department").addEventListener("change", (e) => {
  filter.departmentId = e.target.value;
  renderEmployees();
});
document.getElementById("filter-type").addEventListener("change", (e) => {
  filter.employmentType = e.target.value;
  renderEmployees();
});
document.getElementById("filter-role").addEventListener("change", (e) => {
  filter.role = e.target.value;
  renderEmployees();
});
document.getElementById("clear-filters-btn").addEventListener("click", () => {
  filter.search = "";
  filter.showInactive = true;
  filter.onlyIncomplete = false;
  filter.departmentId = "";
  filter.employmentType = "";
  filter.role = "";
  document.getElementById("search-input").value = "";
  document.getElementById("show-inactive").checked = true;
  document.getElementById("only-incomplete").checked = false;
  document.getElementById("filter-department").value = "";
  document.getElementById("filter-type").value = "";
  document.getElementById("filter-role").value = "";
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

document.getElementById("add-department-btn").addEventListener("click", () => {
  if (!ctx.isAdminOrHigher) return notice("Admins only", "warn");
  openDeptDialog(null);
});
if (!ctx.isAdminOrHigher) {
  document.getElementById("add-department-btn").disabled = true;
}

/* ---------------------------------------------------------------- load */

await reloadAll();

// Deep-link: the grouped top-nav's Organization sub-tab strip points here
// with #employees / #departments / #hierarchy. Open that tab on load and
// whenever the hash changes (same-page sub-tab clicks).
function openTabFromHash() {
  const wanted = location.hash.slice(1);
  if (["employees", "departments", "hierarchy"].includes(wanted) && wanted !== activeTab) {
    document.querySelector(`[data-tab="${wanted}"]`)?.click();
  }
}
openTabFromHash();
window.addEventListener("hashchange", openTabFromHash);

if (ctx.isDeveloper) {
  const delTestBtn = document.getElementById("delete-test-btn");
  delTestBtn.classList.remove("hidden");
  delTestBtn.addEventListener("click", async () => {
    const testEmps = employees.filter((e) => e.is_test);
    if (!testEmps.length) return notice("No test staff to delete", "info");
    if (!await confirmDialog({
      title: "Delete test employees",
      message: `Permanently delete ${testEmps.length} test employee${testEmps.length === 1 ? "" : "s"}?`,
      confirmText: "Delete",
      danger: true,
    })) return;
    const { error } = await sb
      .from("users")
      .delete()
      .in("id", testEmps.map((e) => e.id))
      .eq("organisation_id", currentOrgId);
    if (error) return notice(error.message, "error");
    notice(`Deleted ${testEmps.length} test employee${testEmps.length === 1 ? "" : "s"}`, "success");
    await reloadAll();
  });
}

async function reloadAll() {
  if (!currentOrgId) return;
  await Promise.all([loadDepartments(), loadEmployees(), loadAdmins()]);
  populateDepartmentFilter();
  renderEmployees();
  if (activeTab === "departments") renderDepartments();
  if (activeTab === "org") renderOrg();
  if (activeTab === "management") renderManagement();
}

async function loadEmployees() {
  const { data, error } = await sb
    .from("users")
    .select(
      // auth_user_id is required by openDialog and syncAdminRole; keep it.
      "id, name, email, department, department_id, employee_code, cost_rate, sell_rate, employment_type, overtime_threshold_hours, receives_overtime, active, organisation_id, is_manager, is_test, auth_user_id, rate_source_department_id, can_view_clock_comparison, clock_view_scope"
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
    .select("id, name, active, manager_id, cost_rate, sell_rate, is_overhead, require_task")
    .eq("organisation_id", currentOrgId)
    .order("name");
  if (error) {
    notice(`Couldn't load departments: ${error.message}`, "error", { sticky: true });
    departments = [];
    rebuildDeptById();
    return;
  }
  departments = data || [];
  rebuildDeptById();
}

async function loadAdmins() {
  if (!currentOrgId) return;
  const { data } = await sb
    .from("admins")
    .select("user_id")
    .eq("organisation_id", currentOrgId)
    .eq("role", "admin");
  adminUserIds = new Set((data || []).map((r) => r.user_id));
}

/* ---------------------------------------------------------------- employees tab */

function missingFields(emp) {
  const missing = [];
  if (!emp.department_id) missing.push("department");
  const dept = emp.department_id ? deptById.get(emp.department_id) : null;
  const isOverhead = dept?.is_overhead || false;
  if (!isOverhead) {
    const effectiveCost = emp.cost_rate ?? dept?.cost_rate ?? null;
    const effectiveSell = emp.sell_rate ?? dept?.sell_rate ?? null;
    if (effectiveCost == null) missing.push("cost rate");
    if (effectiveSell == null) missing.push("sell rate");
  }
  if (!emp.employment_type) missing.push("employment type");
  return missing;
}

function effectiveRate(emp, field) {
  // 1. Explicit rate-source department wins (manager in Management
  //    overhead dept who bills at Workshop's rate, etc).
  if (emp.rate_source_department_id) {
    const src = deptById.get(emp.rate_source_department_id);
    if (src && src[field] != null) {
      return { value: Number(src[field]), source: "borrowed", sourceName: src.name };
    }
  }
  const dept = emp.department_id ? deptById.get(emp.department_id) : null;
  // 2. Per-user override.
  if (emp[field] != null) return { value: Number(emp[field]), source: "employee" };
  // 3. Home dept default — but only if the home dept isn't overhead.
  if (dept?.is_overhead) return { value: null, source: "overhead" };
  if (dept && dept[field] != null) return { value: Number(dept[field]), source: "dept" };
  return null;
}

function fmtRate(r) {
  if (!r) return '<span class="muted">—</span>';
  if (r.source === "overhead") return '<span class="muted">N/A</span>';
  if (r.source === "borrowed") {
    return `<span title="Borrowed from ${escapeHtml(r.sourceName || "")}">${r.value.toFixed(2)} <span class="small muted">(${escapeHtml(r.sourceName || "dept")})</span></span>`;
  }
  return r.source === "dept"
    ? `<span title="From department">${r.value.toFixed(2)} <span class="small muted">(dept)</span></span>`
    : r.value.toFixed(2);
}

function deptName(id) {
  const d = deptById.get(id);
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
    .filter((e) => (filter.onlyIncomplete ? missingFields(e).length > 0 : true))
    .filter((e) => {
      if (!filter.departmentId) return true;
      if (filter.departmentId === "__none") return !e.department_id;
      return String(e.department_id) === filter.departmentId;
    })
    .filter((e) => !filter.employmentType || e.employment_type === filter.employmentType)
    .filter((e) => {
      if (!filter.role) return true;
      if (filter.role === "manager")      return !!e.is_manager;
      if (filter.role === "admin")        return e.auth_user_id && adminUserIds.has(e.auth_user_id);
      if (filter.role === "receives_ot")  return !!e.receives_overtime;
      if (filter.role === "clock_viewer") return !!e.can_view_clock_comparison;
      return true;
    });

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
          <td class="num">${fmtRate(effectiveRate(e, "cost_rate"))}</td>
          <td class="num">${fmtRate(effectiveRate(e, "sell_rate"))}</td>
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
    body.innerHTML = `<tr><td colspan="6" class="muted small" style="text-align:center;padding:16px">No departments yet — ${ctx.isAdminOrHigher ? 'click "+ Add department"' : "an admin can add one"}.</td></tr>`;
    return;
  }

  body.innerHTML = departments
    .map((d) => {
      const typeChip = d.is_overhead
        ? `<span class="chip missing">Overhead</span>`
        : `<span class="small muted">Billable</span>`;
      const costCell = d.is_overhead
        ? `<span class="muted">N/A</span>`
        : d.cost_rate != null ? Number(d.cost_rate).toFixed(2) : `<span class="muted">—</span>`;
      const sellCell = d.is_overhead
        ? `<span class="muted">N/A</span>`
        : d.sell_rate != null ? Number(d.sell_rate).toFixed(2) : `<span class="muted">—</span>`;
      const activeCell = d.active
        ? `<span class="small muted">Yes</span>`
        : `<span class="chip">Inactive</span>`;
      return `
        <tr>
          <td>${escapeHtml(d.name)}</td>
          <td>${typeChip}</td>
          <td class="num">${costCell}</td>
          <td class="num">${sellCell}</td>
          <td>${activeCell}</td>
          <td><button class="ghost" data-edit-dept="${d.id}">${ctx.isAdminOrHigher ? "Edit" : "View"}</button></td>
        </tr>`;
    })
    .join("");

  body.querySelectorAll("[data-edit-dept]").forEach((b) =>
    b.addEventListener("click", () => openDeptDialog(Number(b.dataset.editDept)))
  );
}

/* ---------------------------------------------------------------- department dialog */

function openDeptDialog(deptId) {
  const dialog = document.getElementById("dept-dialog");
  const isEdit = deptId != null;
  const dept = isEdit ? departments.find((d) => d.id === deptId) : null;

  document.getElementById("dept-dialog-title").textContent = isEdit ? "Edit department" : "Add department";
  document.getElementById("fd-name").value = dept?.name || "";
  document.getElementById("fd-overhead").checked = dept?.is_overhead || false;
  document.getElementById("fd-require-task").checked = dept?.require_task || false;
  document.getElementById("fd-cost").value = dept?.cost_rate ?? "";
  document.getElementById("fd-sell").value = dept?.sell_rate ?? "";
  document.getElementById("fd-active").checked = dept?.active ?? true;
  document.getElementById("fd-rate-fields").style.display = dept?.is_overhead ? "none" : "";

  document.getElementById("fd-overhead").onchange = (e) => {
    document.getElementById("fd-rate-fields").style.display = e.target.checked ? "none" : "";
  };

  const delBtn = document.getElementById("dept-delete-btn");
  if (isEdit && ctx.isAdminOrHigher) {
    delBtn.classList.remove("hidden");
    delBtn.onclick = () => deleteDept(deptId);
  } else {
    delBtn.classList.add("hidden");
  }

  const form = document.getElementById("dept-form");
  form.querySelectorAll("input,button[type=submit]").forEach((el) => {
    el.disabled = !ctx.isAdminOrHigher;
  });
  document.getElementById("dept-cancel").disabled = false;
  form.dataset.deptId = isEdit ? String(deptId) : "";

  dialog.showModal();
}

document.getElementById("dept-cancel").addEventListener("click", () =>
  document.getElementById("dept-dialog").close()
);

document.getElementById("dept-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!ctx.isAdminOrHigher) return notice("Admins only", "warn");
  if (!currentOrgId) return notice("No organisation selected", "error");

  const name = document.getElementById("fd-name").value.trim();
  if (!name) return notice("Name is required", "warn");

  const isOverhead = document.getElementById("fd-overhead").checked;
  const payload = {
    name,
    is_overhead: isOverhead,
    require_task: document.getElementById("fd-require-task").checked,
    cost_rate: isOverhead ? null : (document.getElementById("fd-cost").value === "" ? null : Number(document.getElementById("fd-cost").value)),
    sell_rate: isOverhead ? null : (document.getElementById("fd-sell").value === "" ? null : Number(document.getElementById("fd-sell").value)),
    active: document.getElementById("fd-active").checked,
  };

  const form = e.currentTarget;
  const deptId = form.dataset.deptId ? Number(form.dataset.deptId) : null;

  if (deptId) {
    const { error } = await sb
      .from("departments")
      .update(payload)
      .eq("id", deptId)
      .eq("organisation_id", currentOrgId);
    if (error) return notice(error.message, "error");
    notice("Saved", "success");
  } else {
    const { error } = await sb
      .from("departments")
      .insert({ organisation_id: currentOrgId, ...payload });
    if (error) return notice(error.message, "error");
    notice(`Added "${name}"`, "success");
  }

  document.getElementById("dept-dialog").close();
  await reloadAll();
});

async function deleteDept(id) {
  const d = departments.find((x) => x.id === id);
  const inUse = employees.filter((e) => e.active && e.department_id === id).length;
  const msg = inUse
    ? `Delete "${d?.name}"? ${inUse} employee(s) will be left unassigned.`
    : `Delete "${d?.name}"?`;
  if (!await confirmDialog({ title: "Delete department", message: msg, confirmText: "Delete", danger: true })) return;
  const { error } = await sb
    .from("departments")
    .delete()
    .eq("id", id)
    .eq("organisation_id", currentOrgId);
  if (error) return notice(error.message, "error");
  document.getElementById("dept-dialog").close();
  await reloadAll();
}

/* ---------------------------------------------------------------- dialog */

function updateRateRef(deptId) {
  const ref = document.getElementById("rate-ref");
  const isSpecific = document.getElementById("f-specific-rate").checked;
  if (isSpecific) {
    ref.style.display = "none";
    return;
  }
  const dept = deptId ? departments.find((d) => d.id === deptId) : null;
  if (dept && (dept.cost_rate != null || dept.sell_rate != null)) {
    ref.textContent = `Department default: cost $${Number(dept.cost_rate ?? 0).toFixed(2)}/hr · sell $${Number(dept.sell_rate ?? 0).toFixed(2)}/hr`;
    ref.style.display = "";
  } else if (dept) {
    ref.textContent = `Department "${dept.name}" has no default rates set.`;
    ref.style.display = "";
  } else {
    ref.textContent = "No department selected — no default rate available.";
    ref.style.display = "";
  }
}

function openDialog(empId) {
  const dialog = document.getElementById("employee-dialog");
  const isEdit = empId != null;
  const emp = isEdit ? employees.find((e) => e.id === empId) : null;

  document.getElementById("dialog-title").textContent = isEdit ? "Edit employee" : "Add employee";
  document.getElementById("f-name").value = emp?.name || "";
  document.getElementById("f-email").value = emp?.email || "";
  document.getElementById("f-code").value = emp?.employee_code || "";
  document.getElementById("f-employment").value = emp?.employment_type || "waged";
  const hasSpecificRate = emp
    ? (emp.cost_rate != null || emp.sell_rate != null || emp.rate_source_department_id != null)
    : false;
  document.getElementById("f-specific-rate").checked = hasSpecificRate;
  document.getElementById("f-cost").value = emp?.cost_rate ?? "";
  document.getElementById("f-sell").value = emp?.sell_rate ?? "";

  // Rate-source dropdown: "Custom" + every active department. Pre-selects
  // the saved rate_source_department_id when present.
  const rateSourceSel = document.getElementById("f-rate-source");
  rateSourceSel.innerHTML = `<option value="custom">Custom values below</option>` +
    departments
      .filter((d) => d.active)
      .map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`)
      .join("");
  const usingDeptRate = emp?.rate_source_department_id != null;
  rateSourceSel.value = usingDeptRate ? String(emp.rate_source_department_id) : "custom";

  // Show/hide rate-source wrapper + numeric inputs based on the two toggles.
  const refreshRateUi = () => {
    const specific = document.getElementById("f-specific-rate").checked;
    const sourceIsDept = rateSourceSel.value !== "custom";
    document.getElementById("rate-source-wrap").style.display = specific ? "" : "none";
    document.getElementById("rate-fields").style.display      = specific && !sourceIsDept ? "" : "none";
    updateRateRef(Number(document.getElementById("f-department").value) || null);
  };
  refreshRateUi();

  document.getElementById("f-ot").value = emp?.overtime_threshold_hours ?? 40;
  document.getElementById("f-manager").checked = emp?.is_manager || false;
  // Receives-overtime defaults to false for new employees (majority of
  // staff are salaried / contractor and don't accrue OT) and respects the
  // saved value for existing ones. ?? not || so an explicit false sticks.
  document.getElementById("f-receives-ot").checked = emp?.receives_overtime ?? false;
  document.getElementById("f-admin").checked = emp?.auth_user_id ? adminUserIds.has(emp.auth_user_id) : false;
  const clockViewerCb = document.getElementById("f-clock-viewer");
  clockViewerCb.checked = !!emp?.can_view_clock_comparison;
  document.getElementById("f-clock-scope").value =
    emp?.clock_view_scope === "managed" ? "managed" : "all";
  // The scope selector is only meaningful when the person can reach the
  // Timeclock page, so it tracks the viewer checkbox.
  const refreshClockScopeUi = () => {
    document.getElementById("clock-scope-wrap").classList
      .toggle("hidden", !clockViewerCb.checked);
  };
  refreshClockScopeUi();
  clockViewerCb.onchange = refreshClockScopeUi;
  if (ctx.isDeveloper) {
    document.getElementById("test-staff-wrap").classList.remove("hidden");
    document.getElementById("f-test").checked = emp?.is_test || false;
  }

  document.getElementById("f-specific-rate").onchange = refreshRateUi;
  rateSourceSel.onchange = refreshRateUi;
  document.getElementById("f-department").onchange = () => {
    updateRateRef(Number(document.getElementById("f-department").value) || null);
  };

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

  const delBtn = document.getElementById("delete-emp-btn");
  if (isEdit && ctx.isDeveloper) {
    delBtn.classList.remove("hidden");
    delBtn.onclick = () => deleteEmployee(emp.id, emp.name);
  } else {
    delBtn.classList.add("hidden");
  }

  // Reset password is admin-only and only meaningful once an auth account
  // exists. Shows next to Deactivate; clicking confirms then resets to
  // the default 'PASSWORD' and forces a change on next login.
  const resetBtn = document.getElementById("reset-password-btn");
  if (isEdit && ctx.isAdminOrHigher && emp.auth_user_id) {
    resetBtn.classList.remove("hidden");
    resetBtn.onclick = () => resetEmployeePassword(emp.id, emp.name);
  } else {
    resetBtn.classList.add("hidden");
  }

  // Reset-a-week is developer-only: wipes one employee's timesheet for a
  // chosen week so the developer can re-test or rescue a stuck row.
  const resetWeekBtn = document.getElementById("reset-week-btn");
  if (isEdit && ctx.isDeveloper) {
    resetWeekBtn.classList.remove("hidden");
    resetWeekBtn.onclick = () => resetEmployeeWeek(emp.id, emp.name);
  } else {
    resetWeekBtn.classList.add("hidden");
  }

  // Revert-exported is the escape hatch when the Infusion export went
  // out but payroll lost the file. Flips that week's timesheet from
  // 'exported' back to 'approved' so the next export pulls it again.
  const revertBtn = document.getElementById("revert-exported-btn");
  if (isEdit && ctx.isDeveloper) {
    revertBtn.classList.remove("hidden");
    revertBtn.onclick = () => revertExportedWeek(emp.id, emp.name);
  } else {
    revertBtn.classList.add("hidden");
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

async function getEmpIdByEmail(email) {
  if (!email) return null;
  const { data } = await sb
    .from("users")
    .select("id")
    .eq("organisation_id", currentOrgId)
    .ilike("email", email)
    .maybeSingle();
  return data?.id || null;
}

async function syncAdminRole(userId, wantAdmin) {
  const { data: emp } = await sb
    .from("users")
    .select("auth_user_id")
    .eq("id", userId)
    .maybeSingle();
  if (!emp?.auth_user_id) return;

  const isAdmin = adminUserIds.has(emp.auth_user_id);
  let mutated = false;
  if (wantAdmin && !isAdmin) {
    if (!await confirmDialog({ title: "Promote to admin", message: "Are you sure you want to make this employee an admin?", confirmText: "Promote" })) return;
    await sb.from("admins").upsert(
      { user_id: emp.auth_user_id, organisation_id: currentOrgId, role: "admin" },
      { onConflict: "user_id" }
    );
    mutated = true;
  } else if (!wantAdmin && isAdmin) {
    await sb.from("admins").delete()
      .eq("user_id", emp.auth_user_id)
      .eq("organisation_id", currentOrgId);
    mutated = true;
  }
  // If the operator just changed their own admin row, the cached
  // user-context (5-min TTL) is now stale on this tab. Clear it so the
  // next page load re-resolves the role.
  if (mutated && emp.auth_user_id === ctx.session?.user?.id) {
    clearUserContextCache(ctx.session);
  }
}

function friendlyConstraintMsg(error, payload) {
  const msg = error.message || "";
  if (msg.includes("users_org_employee_code_uniq"))
    return `Employee code "${payload.employee_code}" is already in use.`;
  if (msg.includes("users_org_email_uniq"))
    return `Email "${payload.email}" is already in use.`;
  return msg;
}

document.getElementById("employee-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!ctx.isAdminOrHigher) return notice("Admins only", "warn");

  const form = e.currentTarget;
  // Rate source: "custom" means use the numeric inputs; any other value
  // is a department id whose rates this user inherits (so we null out
  // the per-user cost/sell to avoid two sources fighting each other).
  const specific = document.getElementById("f-specific-rate").checked;
  const rateSourceVal = document.getElementById("f-rate-source").value;
  const usingDeptRate = specific && rateSourceVal !== "custom";

  const payload = {
    name: document.getElementById("f-name").value.trim(),
    email: document.getElementById("f-email").value.trim() || null,
    department_id: document.getElementById("f-department").value
      ? Number(document.getElementById("f-department").value)
      : null,
    employment_type: document.getElementById("f-employment").value,
    employee_code: document.getElementById("f-code").value.trim() || null,
    cost_rate: specific && !usingDeptRate && document.getElementById("f-cost").value !== ""
      ? Number(document.getElementById("f-cost").value) : null,
    sell_rate: specific && !usingDeptRate && document.getElementById("f-sell").value !== ""
      ? Number(document.getElementById("f-sell").value) : null,
    rate_source_department_id: usingDeptRate ? Number(rateSourceVal) : null,
    overtime_threshold_hours:
      document.getElementById("f-ot").value === ""
        ? null
        : Number(document.getElementById("f-ot").value),
    is_manager: document.getElementById("f-manager").checked,
    receives_overtime: document.getElementById("f-receives-ot").checked,
    can_view_clock_comparison: document.getElementById("f-clock-viewer").checked,
    // Scope is only meaningful for a viewer; reset to 'all' when the
    // viewer permission is off so a stale 'managed' doesn't linger.
    clock_view_scope: document.getElementById("f-clock-viewer").checked
      ? document.getElementById("f-clock-scope").value
      : "all",
    is_test: ctx.isDeveloper ? document.getElementById("f-test").checked : undefined,
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
    if (error) return notice(friendlyConstraintMsg(error, payload), "error");

    // Provision a login account if email was added and no auth account exists
    const prev = employees.find((e) => e.id === empId);
    if (payload.email && !prev?.auth_user_id) {
      await provisionAndShowPassword(empId, payload.name);
    }

    // If the operator just edited their own row (e.g. moved themselves
    // into a new department), the cached user-context (5-min TTL) is
    // now stale on this tab. Clear it so the next page load re-resolves
    // the role and the timesheet page sees the new department.
    maybeClearOwnContext(empId);

    notice("Saved", "success");
  } else {
    const { data: newEmp, error } = await sb.rpc("create_employee", {
      p_org_id: currentOrgId,
      p_name: payload.name,
      p_email: payload.email,
      p_department_id: payload.department_id,
      p_cost_rate: payload.cost_rate,
      p_sell_rate: payload.sell_rate,
      p_employment_type: payload.employment_type,
      p_employee_code: payload.employee_code,
      p_overtime_threshold_hours: payload.overtime_threshold_hours,
      p_receives_overtime: payload.receives_overtime,
    });
    if (error) return notice(friendlyConstraintMsg(error, payload), "error");

    // Provision a login account (random temp password) if employee has an email
    const newEmpId = Array.isArray(newEmp) ? newEmp[0]?.id : newEmp?.id;
    if (payload.email && newEmpId) {
      await provisionAndShowPassword(newEmpId, payload.name);
    }

    // create_employee RPC doesn't take the newer columns. Patch them in
    // via UPDATE so the dialog's choices on the add path actually stick.
    if (newEmpId && (payload.rate_source_department_id != null || payload.can_view_clock_comparison)) {
      const { error: patchErr } = await sb.from("users")
        .update({
          rate_source_department_id: payload.rate_source_department_id,
          can_view_clock_comparison: payload.can_view_clock_comparison,
          clock_view_scope: payload.clock_view_scope,
        })
        .eq("id", newEmpId)
        .eq("organisation_id", currentOrgId);
      if (patchErr) console.warn("post-create patch:", patchErr.message);
    }

    notice("Employee created", "success");
  }

  // Sync admin role
  const wantAdmin = document.getElementById("f-admin").checked;
  const savedEmpId = empId || (await getEmpIdByEmail(payload.email));
  if (savedEmpId) await syncAdminRole(savedEmpId, wantAdmin);

  document.getElementById("employee-dialog").close();
  await reloadAll();
});

async function deactivateEmployee(id) {
  if (!await confirmDialog({ title: "Deactivate employee", message: "Deactivate this employee? Their history will be kept.", confirmText: "Deactivate" })) return;
  const { error } = await sb
    .from("users")
    .update({ active: false })
    .eq("id", id)
    .eq("organisation_id", currentOrgId);
  if (error) return notice(error.message, "error");
  maybeClearOwnContext(id);
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
  maybeClearOwnContext(id);
  document.getElementById("employee-dialog").close();
  notice("Reactivated", "success");
  await reloadAll();
}

// Reset password to the default 'PASSWORD' and force a change on next
// login. The actual update happens server-side via the SECURITY DEFINER
// RPC (migration 058) because clients can't write to auth.users.
async function resetEmployeePassword(id, name) {
  if (!await confirmDialog({
    title: "Reset password",
    message: `Reset ${name}'s password to the default? They'll be required to set a new one on next login.`,
    confirmText: "Reset password",
  })) return;
  const { data: tempPw, error } = await sb.rpc("reset_employee_password", { p_user_id: id });
  if (error) return notice(error.message, "error");
  await confirmDialog({
    title: "Password reset",
    message: `${name}'s temporary password is:\n\n${tempPw}\n\nShare it with them securely. They'll be required to choose a new one on first sign-in. This is shown only once.`,
    confirmText: "Done",
    cancelText: "",
  });
}

// Provision a login and show the admin the generated one-time password.
// Returns null (no dialog) when the account already existed.
async function provisionAndShowPassword(empId, name) {
  const { data: tempPw, error } = await sb.rpc("provision_employee_login", { p_user_id: empId });
  if (error) { console.warn("provision_employee_login:", error.message); return; }
  if (!tempPw) return; // linked to an existing auth account; no new password
  await confirmDialog({
    title: "Login created",
    message: `Temporary password for ${name || "this employee"}:\n\n${tempPw}\n\nShare it with them securely. They'll choose their own on first sign-in. This is shown only once.`,
    confirmText: "Done",
    cancelText: "",
  });
}

// Developer-only: wipe one user's timesheet+entries for a chosen week.
// Prompt for any date in the target week; the server-side RPC snaps to
// the Monday via the same week_start the row was created with.
async function resetEmployeeWeek(id, name) {
  const today = fmtDate(getActiveMonday());
  const raw = await promptDialog({
    title: `Reset week for ${name}`,
    message: "Enter any date within the week to reset (Monday is best). The timesheet and all its entries will be deleted.",
    defaultValue: today,
    placeholder: "YYYY-MM-DD",
    confirmText: "Continue",
  });
  if (!raw) return;
  const parsed = new Date(raw + "T00:00:00");
  if (isNaN(parsed)) return notice("Invalid date", "warn");
  const weekStart = fmtDate(getMonday(parsed));
  if (!await confirmDialog({
    title: "Reset week",
    message: `Permanently delete ${name}'s timesheet for the week of ${weekStart}? This cannot be undone.`,
    confirmText: "Delete week",
    danger: true,
  })) return;
  const { data: count, error } = await sb.rpc("reset_user_week", { p_user_id: id, p_week_start: weekStart });
  if (error) return notice(error.message, "error");
  invalidateWeekDashboard(currentOrgId, weekStart);
  if (!count) {
    notice(`No timesheet existed for ${name} the week of ${weekStart}`, "info");
  } else {
    notice(`Reset ${name}'s timesheet for the week of ${weekStart}`, "success");
  }
}

// Developer-only: flip exported -> approved for one user's week so the
// Infusion export can re-run for it. Used when payroll lost the file.
async function revertExportedWeek(id, name) {
  const today = fmtDate(getActiveMonday());
  const raw = await promptDialog({
    title: `Revert exported week for ${name}`,
    message: "Enter any date within the week to revert. The timesheet flips from 'exported' back to 'approved' so the next Infusion export picks it up.",
    defaultValue: today,
    placeholder: "YYYY-MM-DD",
    confirmText: "Continue",
  });
  if (!raw) return;
  const parsed = new Date(raw + "T00:00:00");
  if (isNaN(parsed)) return notice("Invalid date", "warn");
  const weekStart = fmtDate(getMonday(parsed));

  // Find the timesheet id for this user+week so we can call the RPC.
  const { data: ts, error: lookupErr } = await sb.from("timesheets")
    .select("id, status")
    .eq("user_id", id)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (lookupErr) return notice(lookupErr.message, "error");
  if (!ts) return notice(`No timesheet for ${name} the week of ${weekStart}`, "info");
  if (ts.status !== "exported") {
    return notice(`Timesheet status is "${ts.status}", not "exported" — nothing to revert.`, "info");
  }
  if (!await confirmDialog({
    title: "Revert exported timesheet",
    message: `Flip ${name}'s timesheet for the week of ${weekStart} back to "approved"? The next Infusion export will include it again.`,
    confirmText: "Revert",
  })) return;
  const { error } = await sb.rpc("reset_to_approved", { p_timesheet_id: ts.id });
  if (error) return notice(error.message, "error");
  invalidateWeekDashboard(currentOrgId, weekStart);
  notice(`Reverted ${name}'s timesheet for the week of ${weekStart}`, "success");
}

function maybeClearOwnContext(empId) {
  const emp = employees.find((e) => e.id === empId);
  if (emp?.auth_user_id && emp.auth_user_id === ctx.session?.user?.id) {
    clearUserContextCache(ctx.session);
  }
}
async function deleteEmployee(id, name) {
  if (!await confirmDialog({ title: "Delete employee", message: `Permanently delete ${name}? This cannot be undone.`, confirmText: "Delete", danger: true })) return;
  const { error } = await sb
    .from("users")
    .delete()
    .eq("id", id)
    .eq("organisation_id", currentOrgId);
  if (error) return notice(error.message, "error");
  document.getElementById("employee-dialog").close();
  notice("Deleted", "success");
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
