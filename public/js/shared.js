// Shared utilities for the Temporium timesheet module.
// Narrow by design — more helpers land here as later units ship.

/* ---------------------------------------------------------------- notices */

/** Flash a notice into #notice. Level: info | warn | error | success. */
export function notice(message, level = "info", { sticky = false } = {}) {
  const el = document.getElementById("notice");
  if (!el) {
    console[level === "error" ? "error" : "log"](message);
    return;
  }
  el.className = `notice ${level}`;
  el.textContent = message;
  el.classList.remove("hidden");
  if (!sticky) {
    clearTimeout(notice._t);
    notice._t = setTimeout(() => el.classList.add("hidden"), 5000);
  }
}

/* ---------------------------------------------------------------- escape */

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ---------------------------------------------------------------- router */
//
// Called after sign-in or sign-up succeeds. Runs the idempotent employee
// claim RPC so that any pending roster linkage is picked up, then redirects
// to the right landing page for whatever role the session turned out to be.

export async function routeAfterAuth(sb) {
  // 1. Try to claim an employee roster row. Safe no-op if already linked, or
  //    if the auth email doesn't match any unclaimed users row.
  const { data: claim } = await sb
    .rpc("claim_employee_by_email")
    .catch((err) => ({ data: null, error: err }));

  // 2. Are they an admin / manager / developer?
  const [{ data: isDeveloper }, { data: adminRow }] = await Promise.all([
    sb.rpc("is_developer").then((r) => ({ data: !!r.data })).catch(() => ({ data: false })),
    sb.from("admins").select("role").maybeSingle(),
  ]);

  const isPrivileged = isDeveloper || !!adminRow;

  if (isPrivileged) {
    location.replace("/admin.html");
    return;
  }

  // 3. Employee with a linked users row → /welcome.html (later units will
  //    route this to /timesheet.html).
  if (claim?.claimed) {
    location.replace("/welcome.html");
    return;
  }

  // 4. Signed in but not yet on the roster and not an admin — show the
  //    "please contact your admin" page.
  location.replace("/welcome.html?unlinked=1");
}
