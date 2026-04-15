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

/* ---------------------------------------------------------------- topbar */

/**
 * Render the shared top-bar. Target: <header class="topbar" id="topbar"></header>.
 * Pages pass `active` to highlight the current section.
 *
 * @param {object}  opts
 * @param {object}  opts.session        Supabase session
 * @param {boolean} opts.isDeveloper
 * @param {object|null} opts.adminRow   The caller's admins row (or null)
 * @param {Array}   opts.orgs           All orgs (developers only) or null
 * @param {number}  opts.currentOrgId
 * @param {function(number):void} opts.onOrgChange
 * @param {"admin"|"staff"|""} opts.active
 */
export function renderTopbar(opts) {
  const el = document.getElementById("topbar");
  if (!el) return;

  const role = opts.adminRow?.role || (opts.isDeveloper ? "developer" : null);
  const canSeeAdminNav =
    role === "admin" || role === "manager" || role === "developer";

  const links = [
    { key: "admin", href: "/admin.html", label: "Admin", show: canSeeAdminNav },
    { key: "staff", href: "/staff.html", label: "Staff", show: canSeeAdminNav },
  ];

  const orgSwitcher =
    opts.isDeveloper && Array.isArray(opts.orgs)
      ? `<select id="org-switcher">
            ${opts.orgs
              .map(
                (o) =>
                  `<option value="${o.id}"${o.id === opts.currentOrgId ? " selected" : ""}>${
                    escapeHtml(o.name)
                  }${o.active ? "" : " (inactive)"}</option>`
              )
              .join("")}
          </select>`
      : "";

  el.innerHTML = `
    <div class="brand">Temporium</div>
    <nav>
      ${links
        .filter((l) => l.show)
        .map(
          (l) =>
            `<a href="${l.href}" class="${opts.active === l.key ? "active" : ""}">${l.label}</a>`
        )
        .join("")}
    </nav>
    <div class="grow"></div>
    <div class="row-flex">
      ${orgSwitcher}
      <span class="who">${escapeHtml(opts.session?.user?.email || "")}</span>
      <a href="#" id="signout-link" class="muted">Sign out</a>
    </div>
  `;

  if (orgSwitcher && typeof opts.onOrgChange === "function") {
    document
      .getElementById("org-switcher")
      .addEventListener("change", (e) => opts.onOrgChange(Number(e.target.value)));
  }

  document.getElementById("signout-link").addEventListener("click", async (e) => {
    e.preventDefault();
    const { getSupabase } = await import("/js/supabase-client.js");
    const sb = await getSupabase();
    await sb.auth.signOut();
    location.href = "/signin.html";
  });
}

/* ---------------------------------------------------------------- router */
//
// Called after sign-in or sign-up succeeds. Runs the idempotent employee
// claim RPC so that any pending roster linkage is picked up, then redirects
// to the right landing page for whatever role the session turned out to be.

export async function routeAfterAuth(sb) {
  let claim = null;
  try {
    const res = await sb.rpc("claim_employee_by_email");
    claim = res.data;
  } catch (err) {
    console.warn("claim_employee_by_email failed, continuing", err);
  }

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

  if (claim?.claimed) {
    location.replace("/welcome.html");
    return;
  }

  location.replace("/welcome.html?unlinked=1");
}

/* ---------------------------------------------------------------- auth */
//
// Common auth + role + org resolution used by /admin.html and /staff.html.
// Returns the pieces every admin-side page needs, or redirects and throws if
// the caller isn't allowed in.

export async function requireAdmin(sb, { allowManager = true } = {}) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    location.replace("/signin.html");
    throw new Error("not signed in");
  }

  let isDeveloper = false;
  let adminRow = null;
  try {
    const res = await sb.rpc("is_developer");
    isDeveloper = !!res.data;
  } catch {}
  try {
    const res = await sb
      .from("admins")
      .select("organisation_id, role")
      .eq("user_id", session.user.id)
      .maybeSingle();
    adminRow = res.data;
  } catch {}

  const role = adminRow?.role || (isDeveloper ? "developer" : null);
  const canView =
    role === "developer" || role === "admin" || (allowManager && role === "manager");

  if (!canView) {
    location.replace("/welcome.html");
    throw new Error("not admin");
  }

  // Resolve the list of orgs the caller can act on, and the current selection.
  let orgs = null;
  let currentOrgId;
  if (isDeveloper) {
    const { data: allOrgs } = await sb
      .from("organisations")
      .select("id, name, slug, active")
      .order("id");
    orgs = allOrgs || [];
    const saved = Number(localStorage.getItem("temporium-dev-org-id"));
    currentOrgId = orgs.find((o) => o.id === saved)?.id || orgs[0]?.id || null;
  } else {
    currentOrgId = adminRow?.organisation_id || null;
  }

  return {
    session,
    isDeveloper,
    adminRow,
    role,
    isAdminOrHigher: role === "admin" || role === "developer",
    orgs,
    currentOrgId,
  };
}
