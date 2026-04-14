// Admin page — Unit 1 scope: Departments CRUD for the current organisation.
//
// Follows the Attendium Phase-1 patterns:
//   - Every read filters by the currently-selected organisation_id. For
//     regular admins that's their own org (derived server-side by RLS); for
//     developers it's whatever they pick in the org switcher and is passed
//     explicitly on writes via the is_developer() code path.
//   - All writes happen through the standard table endpoints; RLS gates them
//     with is_admin_of(organisation_id).

import { getSupabase } from "/js/supabase-client.js";
import { notice, escapeHtml } from "/js/shared.js";

const sb = await getSupabase();

/* -------------------------------------------------------- auth gate */

const { data: { session } } = await sb.auth.getSession();
if (!session) {
  location.replace("/signup.html"); // Attendium Phase 1 surface
}

// Role detection
const [{ data: isAdmin }, { data: isDeveloper }] = await Promise.all([
  sb.rpc("is_admin").then((r) => ({ data: !!r.data })).catch(() => ({ data: false })),
  sb.rpc("is_developer").then((r) => ({ data: !!r.data })).catch(() => ({ data: false })),
]);

if (!isAdmin && !isDeveloper) {
  document.body.innerHTML =
    `<div class="auth-wrap"><div class="card"><h1>Admin access required</h1>` +
    `<p class="muted">Your account isn't an admin on any organisation.</p></div></div>`;
  throw new Error("not admin");
}

document.getElementById("whoami").textContent = session.user.email || "";
document.getElementById("signout-link").addEventListener("click", async (e) => {
  e.preventDefault();
  await sb.auth.signOut();
  location.href = "/";
});

/* -------------------------------------------------------- org context */
// For developers: pick any org. Persist selection in localStorage.
// For admins: their own org is derived by RLS, but we still need the id for
// the "new department" insert (organisation_id is NOT NULL). We read it from
// the admins table.

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

    const saved = Number(localStorage.getItem("attendium-dev-org-id"));
    currentOrgId =
      orgs?.find((o) => o.id === saved)?.id || orgs?.[0]?.id || null;
    sel.value = String(currentOrgId);

    sel.addEventListener("change", () => {
      currentOrgId = Number(sel.value);
      localStorage.setItem("attendium-dev-org-id", String(currentOrgId));
      loadDepartments();
    });
  } else {
    // Regular admin: look up their admins row to get organisation_id.
    const { data, error } = await sb
      .from("admins")
      .select("organisation_id")
      .eq("user_id", session.user.id)
      .maybeSingle();
    if (error) return notice(error.message, "error");
    currentOrgId = data?.organisation_id || null;
  }

  if (!currentOrgId) {
    notice("No organisation on this account — contact a developer.", "error", {
      sticky: true,
    });
  }
}

/* -------------------------------------------------------- departments */

document.getElementById("add-department").addEventListener("click", addDepartment);
document
  .getElementById("new-department")
  .addEventListener("keydown", (e) => e.key === "Enter" && addDepartment());

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
    body.innerHTML = `<tr><td colspan="3" class="muted small" style="text-align:center;padding:16px">No departments yet — add one above.</td></tr>`;
    return;
  }

  body.innerHTML = data
    .map(
      (d) => `
        <tr data-dept="${d.id}">
          <td><input data-field="name" value="${escapeHtml(d.name)}" style="width:280px" /></td>
          <td><input type="checkbox" data-field="active" ${d.active ? "checked" : ""} /></td>
          <td class="row-flex">
            <button data-save-dept="${d.id}" class="ghost">Save</button>
            <button data-del-dept="${d.id}" class="danger">Delete</button>
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

  const { error } = await sb.from("departments").insert({
    organisation_id: currentOrgId,
    name,
  });
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
    .eq("organisation_id", currentOrgId); // defence in depth
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
