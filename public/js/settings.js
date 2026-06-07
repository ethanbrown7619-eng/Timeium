import { getSupabase } from "/js/supabase-client.js";
import { notice, renderTopbar, escapeHtml, getUserContext, validatePassword, MIN_PASSWORD_LENGTH } from "/js/shared.js";

const sb = await getSupabase();

const { data: { session } } = await sb.auth.getSession();
if (!session) {
  location.replace("/signin.html");
  throw new Error("not signed in");
}

const ctx = await getUserContext(sb, session);
const { isDeveloper, adminRow, isManager, employee: me } = ctx;

renderTopbar({
  sb,
  session,
  isDeveloper,
  isManager,
  adminRow,
  orgs: null,
  currentOrgId: adminRow?.organisation_id || null,
  onOrgChange: () => {},
  active: "settings",
});

document.getElementById("me-email").textContent = session.user.email || "";
document.getElementById("me-name").textContent = me?.name || session.user.email || "";

document.getElementById("pw-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const currentPw = document.getElementById("current-pw").value;
  const pw = document.getElementById("new-pw").value;
  const confirm = document.getElementById("confirm-pw").value;
  const btn = document.getElementById("pw-btn");
  const statusEl = document.getElementById("pw-status");

  if (!currentPw) return notice("Enter your current password", "error");
  if (pw !== confirm) return notice("New passwords do not match", "error");
  const pwCheck = validatePassword(pw);
  if (!pwCheck.ok) return notice(pwCheck.reason, "error");
  if (pw === currentPw) return notice("New password must be different from current", "error");

  btn.disabled = true;
  statusEl.textContent = "Verifying…";

  // Verify the current password by re-authenticating
  const email = session.user.email;
  const { error: signInErr } = await sb.auth.signInWithPassword({ email, password: currentPw });
  if (signInErr) {
    statusEl.textContent = "";
    btn.disabled = false;
    return notice("Current password is incorrect", "error");
  }

  statusEl.textContent = "Saving…";
  const { error } = await sb.auth.updateUser({ password: pw });
  if (error) {
    statusEl.textContent = "";
    btn.disabled = false;
    return notice(error.message || "Failed to update password", "error");
  }

  // SECURITY DEFINER RPC — direct UPDATE is blocked by RLS.
  await sb.rpc("clear_must_change_password");

  document.getElementById("current-pw").value = "";
  document.getElementById("new-pw").value = "";
  document.getElementById("confirm-pw").value = "";
  statusEl.textContent = "Saved";
  btn.disabled = false;
  notice("Password updated", "success");
  setTimeout(() => statusEl.textContent = "", 3000);
});
