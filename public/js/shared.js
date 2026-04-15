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
  //
  //    Supabase's rpc() returns a PromiseLike, not a real Promise — it has
  //    .then() but not .catch(). We await it inside a try/catch so transient
  //    failures don't block the role check.
  let claim = null;
  try {
    const res = await sb.rpc("claim_employee_by_email");
    claim = res.data;
  } catch (err) {
    console.warn("claim_employee_by_email failed, continuing", err);
  }

  // 2. Are they an admin / manager / developer?
  let isDeveloper = false;
  let adminRow = null;
  try {
    const res = await sb.rpc("is_developer");
    isDeveloper = !!res.data;
  } catch (err) {
    console.warn("is_developer failed, continuing", err);
  }
  try {
    const res = await sb.from("admins").select("role").maybeSingle();
    adminRow = res.data;
  } catch (err) {
    console.warn("admins lookup failed, continuing", err);
  }

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
