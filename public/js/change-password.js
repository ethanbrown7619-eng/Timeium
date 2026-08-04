import { getSupabase } from "/js/supabase-client.js";
import { notice, routeAfterAuth, validatePassword, clearUserContextCache } from "/js/shared.js";

const sb = await getSupabase();

const { data: { session } } = await sb.auth.getSession();
if (!session) {
  location.replace("/signin.html");
  throw new Error("not signed in");
}

document.getElementById("change-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = document.getElementById("password").value;
  const confirm = document.getElementById("confirm").value;
  const btn = document.getElementById("submit-btn");

  if (pw !== confirm) {
    notice("Passwords do not match", "error");
    return;
  }
  const pwCheck = validatePassword(pw);
  if (!pwCheck.ok) {
    notice(pwCheck.reason, "error");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Saving…";

  const { error } = await sb.auth.updateUser({ password: pw });
  if (error) {
    notice(error.message || "Failed to update password", "error");
    btn.disabled = false;
    btn.textContent = "Set password";
    return;
  }

  // Clear the must_change_password flag via SECURITY DEFINER RPC —
  // direct UPDATE is blocked by RLS (no self-UPDATE policy on users).
  await sb.rpc("clear_must_change_password");
  // The cached user context still carries mustChangePassword = true; without
  // this the app-wide guard in getUserContext() would bounce the user
  // straight back here for up to the 5-minute context TTL.
  clearUserContextCache(session);

  notice("Password updated", "success");
  setTimeout(() => routeAfterAuth(sb), 500);
});
