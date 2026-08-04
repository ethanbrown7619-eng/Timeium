import { getSupabase } from "/js/supabase-client.js";
import { notice, renderTopbar, escapeHtml, getUserContext, validatePassword, MIN_PASSWORD_LENGTH, clearUserContextCache } from "/js/shared.js";

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

// ---------------------------------------------------------------- QR code
// Renders the user's qr_token — the value the kiosk's QR mode matches
// against — as a scannable code. Generated on demand (button click) so
// the page load stays free of the third-party qrcode library, and the
// code isn't sitting on screen unless asked for.
const qrCard = document.getElementById("qr-card");
const qrBtn = document.getElementById("qr-show-btn");
if (!me && qrCard) {
  // No employee record (e.g. bare admin account) — nothing to scan.
  qrCard.style.display = "none";
}
qrBtn?.addEventListener("click", async () => {
  qrBtn.disabled = true;
  qrBtn.textContent = "Loading…";
  try {
    const { data, error } = await sb
      .from("users")
      .select("qr_token")
      .eq("auth_user_id", session.user.id)
      .maybeSingle();
    if (error) throw error;
    if (!data?.qr_token) throw new Error("Your employee record has no QR token — ask an admin.");
    const QRCode = (await import("https://esm.sh/qrcode@1.5.4")).default;
    await QRCode.toCanvas(document.getElementById("qr-canvas"), data.qr_token, {
      width: 240,
      margin: 2,
      color: { dark: "#0a0a0a", light: "#ffffff" },
    });
    document.getElementById("qr-wrap").style.display = "";
    qrBtn.style.display = "none";
  } catch (err) {
    notice(err.message || "Could not load your QR code", "error");
    qrBtn.disabled = false;
    qrBtn.textContent = "Show my QR code";
  }
});

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
  // Drop the cached context so the app-wide forced-change guard in
  // getUserContext() sees the cleared flag immediately.
  clearUserContextCache(session);

  document.getElementById("current-pw").value = "";
  document.getElementById("new-pw").value = "";
  document.getElementById("confirm-pw").value = "";
  statusEl.textContent = "Saved";
  btn.disabled = false;
  notice("Password updated", "success");
  setTimeout(() => statusEl.textContent = "", 3000);
});
