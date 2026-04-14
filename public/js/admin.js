// Temporium admin page — Unit 1: Departments CRUD for the current organisation.
//
// Auth model: Temporium reuses Attendium's shared core (organisations, users,
// admins). This page is accessible to admin, manager, and developer roles.
// (Manager is currently a read-only role for lookup tables; only admin and
// developer can modify. Manager-specific approval UI lands in a later unit.)
//
// Developer: cross-org via the org switcher (value persisted in localStorage).
// Admin / Manager: locked to their own org (derived from their admins row).

import { getSupabase } from "/js/supabase-client.js";
import { notice, escapeHtml } from "/js/shared.js";

const sb = await getSupabase();

/* -------------------------------------------------------- auth gate */

const { data: { session } } = await sb.auth.getSession();
if (!session) {
  location.replace("/signin.html");
  throw new Error("not signed in");
}

const [{ data: isDeveloper }, adminRow] = await Promise.all([
  sb.rpc("is_developer").then((r) => ({ data: !!r.data })).catch(() => ({ data: false })),
  sb.from("admins").select("organisation_id, role").eq("user_id", session.user.id).maybeSingle(),
]);

const role = adminRow?.data?.role || (isDeveloper ? "developer" : null);
const isAdminOrHigher = role === "admin" || role === "developer";
const canView = isDeveloper || role === "admin" || role === "manager";

if (!canView) {
  // Employee account — send them to the welcome page where the claim RPC
  // can be re-checked / a future /timesheet.html will land them.
  location.replace("/welcome.html");
  throw new Error("not admin");
}

document.getElementById("whoami").textContent = session.user.email || "";
document.getElementById("signout-link").addEventListener("click", async (e) => {
  e.preventDefault();
  await sb.auth.signOut();
  location.href = "/signin.html";
});

/* -------------------------------------------------------- org context */

let currentOrgId = null;
await initOrgContext();

async function initOrgContext() {
  if (isDeveloper) {
    const { data: orgs, error } = await sb
      .from("organisations")
      .select("id, name, slug, active")
      .order("id");
    if (error) return notice(error.message, "error");

    const sel = document.getElementById("org-switcher");
    sel.classList.remove("hidden");
    sel.innerHTML = (orgs || [])
      .map(
        (o) =>
          `<option value="${o.id}">${escapeHtml(o.name)}${o.active ? "" : " (inactive)"}</option>`
      )
      .join("");

    const saved = Number(localStorage.getItem("temporium-dev-org-id"));
    currentOrgId = orgs?.find((o) => o.id === saved)?.id || orgs?.[0]?.id || null;
    if (currentOrgId) sel.value = String(currentOrgId);

    sel.addEventListener("change", () => {
      currentOrgId = Number(sel.value);
      localStorage.setItem("temporium-dev-org-id", String(currentOrgId));
      loadDepartments();
    });
  } else {
    currentOrgId = adminRow?.data?.organisation_id || null;
  }

  if (!currentOrgId) {
    notice(
      "No organisation on this account — contact a developer.",
      "error",
      { sticky: true }
    );
  }
}

/* -------------------------------------------------------- departments */

if (isAdminOrHigher) {
  document.getElementById("add-department").addEventListener("click", addDepartment);
  document
    .getElementById("new-department")
    .addEventListener("keydown", (e) => e.key === "Enter" && addDepartment());
} else {
  // Manager: hide the write controls.
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
    body.innerHTML = `<tr><td colspan="3" class="muted small" style="text-align:center;padding:16px">No departments yet — ${isAdminOrHigher ? "add one above" : "an admin can add one"}.</td></tr>`;
    return;
  }

  body.innerHTML = data
    .map(
      (d) => `
        <tr data-dept="${d.id}">
          <td><input data-field="name" value="${escapeHtml(d.name)}" style="width:280px" ${isAdminOrHigher ? "" : "disabled"} /></td>
          <td><input type="checkbox" data-field="active" ${d.active ? "checked" : ""} ${isAdminOrHigher ? "" : "disabled"} /></td>
          <td class="row-flex">
            ${isAdminOrHigher ? `<button data-save-dept="${d.id}" class="ghost">Save</button>` : ""}
            ${isAdminOrHigher ? `<button data-del-dept="${d.id}" class="danger">Delete</button>` : ""}
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
    .eq("organisation_id", currentOrgId); // defence-in-depth against stale currentOrgId
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

