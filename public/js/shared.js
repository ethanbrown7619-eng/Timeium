// Shared utilities used by every page: auth gating, current-user lookup,
// date helpers, CSV builder, toast notices.

import { getSupabase } from "./supabase-client.js";

/* ------------------------------------------------------------------ auth */

/**
 * Require a signed-in Supabase auth user. Redirects to /login.html if missing.
 * Returns the { authUser, employee, roles } triple.
 *   - authUser: supabase auth row
 *   - employee: matching row in public.users (or null if not yet linked)
 *   - roles: { isAdmin, isManager, isDeveloper }
 */
export async function requireAuth(opts = {}) {
  const sb = await getSupabase();
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    const redirect = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.replace(`/login.html?redirect=${redirect}`);
    // halt execution by returning a never-resolving promise
    return new Promise(() => {});
  }

  const authUser = session.user;

  // Look up employee row (by auth_user_id).
  const { data: empRows } = await sb
    .from("users")
    .select("*")
    .eq("auth_user_id", authUser.id)
    .limit(1);

  const employee = empRows && empRows[0] ? empRows[0] : null;

  // Roles: ping the helper RPCs.
  const [{ data: isAdmin }, { data: isManager }, { data: isDeveloper }] = await Promise.all([
    sb.rpc("is_admin").then((r) => ({ data: !!r.data })).catch(() => ({ data: false })),
    sb.rpc("is_manager").then((r) => ({ data: !!r.data })).catch(() => ({ data: false })),
    sb.rpc("is_developer").then((r) => ({ data: !!r.data })).catch(() => ({ data: false })),
  ]);

  const roles = { isAdmin, isManager, isDeveloper };

  if (opts.requireManager && !isManager) {
    document.body.innerHTML = errorPage("This page requires manager or admin access.");
    return new Promise(() => {});
  }
  if (opts.requireAdmin && !isAdmin) {
    document.body.innerHTML = errorPage("This page requires admin access.");
    return new Promise(() => {});
  }
  if (opts.requireEmployee && !employee) {
    document.body.innerHTML = errorPage(
      "Your login is not linked to an employee record. Ask an admin to link your account."
    );
    return new Promise(() => {});
  }

  return { authUser, employee, roles, supabase: sb };
}

function errorPage(msg) {
  return `
    <div class="auth-wrap">
      <div class="card">
        <h1>Access denied</h1>
        <div class="notice error">${escapeHtml(msg)}</div>
        <button class="ghost" onclick="location.href='/'">Back to home</button>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ nav */

/**
 * Render the shared top-bar. Target element: <header id="topbar"></header>.
 */
export function renderTopbar({ authUser, employee, roles }, active = "") {
  const el = document.getElementById("topbar");
  if (!el) return;

  const links = [
    { href: "/timesheet.html", label: "My Timesheet", show: !!employee, key: "timesheet" },
    { href: "/archive.html",   label: "Archive",      show: !!employee, key: "archive"   },
    { href: "/manager.html",   label: "Approvals",    show: roles.isManager, key: "manager" },
    { href: "/admin.html",     label: "Admin",        show: roles.isAdmin,   key: "admin"   },
  ];

  el.innerHTML = `
    <div class="brand">Timeium</div>
    <nav>
      ${links
        .filter((l) => l.show)
        .map(
          (l) =>
            `<a href="${l.href}" class="${active === l.key ? "active" : ""}">${l.label}</a>`
        )
        .join("")}
    </nav>
    <div class="who">
      ${employee ? escapeHtml(employee.name) : escapeHtml(authUser.email || "—")}
      &nbsp;·&nbsp;
      <a href="#" id="signout-link">Sign out</a>
    </div>
  `;
  document.getElementById("signout-link")?.addEventListener("click", async (e) => {
    e.preventDefault();
    const sb = await getSupabase();
    await sb.auth.signOut();
    window.location.href = "/login.html";
  });
}

/* ------------------------------------------------------------------ dates */

/** Snap a Date to the Monday of its week (local time). */
export function mondayOf(d) {
  const date = new Date(d);
  const dow = date.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const offset = dow === 0 ? -6 : 1 - dow;
  date.setDate(date.getDate() + offset);
  date.setHours(0, 0, 0, 0);
  return date;
}

/** ISO date (YYYY-MM-DD) in local time, NOT UTC. */
export function isoDate(d) {
  const date = new Date(d);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Seven days from Monday → Sunday for the given week_start. */
export function weekDays(weekStart) {
  const start = mondayOf(weekStart);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push(d);
  }
  return days;
}

export const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function formatShortDate(d) {
  return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
export function formatLongDate(d) {
  return new Date(d).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/* ------------------------------------------------------------------ csv */

export function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[,"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function buildCsv(columns, rows) {
  const lines = [columns.map(csvEscape).join(",")];
  for (const r of rows) {
    lines.push(columns.map((c) => csvEscape(r[c])).join(","));
  }
  return lines.join("\n") + "\n";
}

export function downloadCsv(filename, content) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ misc */

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Flash a notice into #notice. Level: info | warn | error | success.
 * Auto-hides after ~5s unless sticky.
 */
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

export function clearNotice() {
  const el = document.getElementById("notice");
  if (el) el.classList.add("hidden");
}
