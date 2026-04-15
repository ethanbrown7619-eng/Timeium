// Temporium admin page — Unit 1: Departments CRUD for the current organisation.

import { getSupabase } from "/js/supabase-client.js";
import { notice, escapeHtml, renderTopbar, requireAdmin } from "/js/shared.js";

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
    loadDepartments();
  },
  active: "admin",
});

if (!currentOrgId) {
  notice(
    "No organisation on this account — contact a developer.",
    "error",
    { sticky: true }
  );
}

/* -------------------------------------------------------- departments */

if (ctx.isAdminOrHigher) {
  document.getElementById("add-department").addEventListener("click", addDepartment);
  document
    .getElementById("new-department")
    .addEventListener("keydown", (e) => e.key === "Enter" && addDepartment());
} else {
  document.getElementById("add-department").disabled = true;
  document.getElementById("new-department").disabled = true;
}

await loadDepartments();

async function loadDepartments() {
  if (!currentOrgId) return;
  const body = document.getElementById("departments-body");
  body.innerHTML = `<tr><td colspan="3" class="muted small" style="text-align:center">Loading…</td></tr>`;

  const { data, error } = await sb
    .from("departments")
    .select("id, name, active")
    .eq("organisation_id", currentOrgId)
    .order("name");

  if (error) {
    body.innerHTML = `<tr><td colspan="3" class="notice error">${escapeHtml(error.message)}</td></tr>`;
    return;
  }

  document.getElementById("dept-count").textContent =
    `${data?.length || 0} department${data?.length === 1 ? "" : "s"}`;

  if (!data || data.length === 0) {
    body.innerHTML = `<tr><td colspan="3" class="muted small" style="text-align:center;padding:16px">No departments yet — ${ctx.isAdminOrHigher ? "add one above" : "an admin can add one"}.</td></tr>`;
    return;
  }

  body.innerHTML = data
    .map(
      (d) => `
        <tr data-dept="${d.id}">
          <td><input data-field="name" value="${escapeHtml(d.name)}" style="width:280px" ${ctx.isAdminOrHigher ? "" : "disabled"} /></td>
          <td><input type="checkbox" data-field="active" ${d.active ? "checked" : ""} ${ctx.isAdminOrHigher ? "" : "disabled"} /></td>
          <td class="row-flex">
            ${ctx.isAdminOrHigher ? `<button data-save-dept="${d.id}" class="ghost">Save</button>` : ""}
            ${ctx.isAdminOrHigher ? `<button data-del-dept="${d.id}" class="danger">Delete</button>` : ""}
          </td>
        </tr>`
    )
    .join("");

  body.querySelectorAll("[data-save-dept]").forEach((b) =>
    b.addEventListener("click", () => saveDepartment(Number(b.dataset.saveDept)))
  );
  body.querySelectorAll("[data-del-dept]").forEach((b) =>
    b.addEventListener("click", () => deleteDepartment(Number(b.dataset.delDept)))
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
  loadDepartments();
}

async function saveDepartment(id) {
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
}

async function deleteDepartment(id) {
  if (!confirm("Delete this department?")) return;
  const { error } = await sb
    .from("departments")
    .delete()
    .eq("id", id)
    .eq("organisation_id", currentOrgId);
  if (error) return notice(error.message, "error");
  loadDepartments();
}
