import { getSupabase } from "/js/supabase-client.js";
import { escapeHtml, clearUserContextCache } from "/js/shared.js";

const sb = await getSupabase();
const { data: { session } } = await sb.auth.getSession();
if (!session) {
  location.replace("/signin.html");
  throw new Error("not signed in");
}

document.getElementById("whoami").textContent = session.user.email || "";
async function doSignOut(e) {
  e?.preventDefault?.();
  try { await sb.auth.signOut(); } catch (err) { console.warn("signOut threw:", err); }
  // Belt-and-braces for the kiosk/deleted-contractor case: even if
  // Supabase's signOut errors (e.g. invalid refresh token because the
  // user record is gone), clear any local session blobs before
  // bouncing to signin so the next reload doesn't re-enter the loop.
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith("sb-")) localStorage.removeItem(k);
    }
  } catch {}
  location.href = "/signin.html";
}

document.getElementById("signout-link").addEventListener("click", doSignOut);
document.getElementById("signout-card-btn")?.addEventListener("click", doSignOut);

// Returns true if the user is now linked to an employee record (and
// navigates to /timesheet.html). Otherwise reveals the unlinked card.
async function tryClaimAndRoute() {
  let claim = null;
  try {
    const res = await sb.rpc("claim_employee_by_email");
    claim = res.data;
  } catch (err) {
    console.warn("claim failed", err);
  }
  if (claim?.claimed || claim?.already_linked) {
    // Bust the user-context cache before navigating. Without this,
    // /timesheet.html reads a stale "no employee" entry from the
    // sessionStorage cache and bounces straight back here, creating
    // a welcome ↔ timesheet redirect loop.
    clearUserContextCache(session);
    location.replace("/timesheet.html");
    return true;
  }
  try {
    const { data } = await sb.from("users").select("id").eq("auth_user_id", session.user.id).maybeSingle();
    if (data) {
      clearUserContextCache(session);
      location.replace("/timesheet.html");
      return true;
    }
  } catch (err) {
    console.warn("welcome users self-lookup failed:", err);
  }
  document.getElementById("unlinked-card").style.display = "";
  document.getElementById("unlinked-email").textContent = session.user.email || "your email";
  return false;
}

document.getElementById("refresh-link").addEventListener("click", async (e) => {
  e.preventDefault?.();
  const btn = document.getElementById("refresh-link");
  btn.disabled = true;
  try {
    await tryClaimAndRoute();
  } finally {
    btn.disabled = false;
  }
});

await tryClaimAndRoute();
