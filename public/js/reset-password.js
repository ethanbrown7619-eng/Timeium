import { getSupabase } from "/js/supabase-client.js";
import { notice, routeAfterAuth, validatePassword } from "/js/shared.js";

const sb = await getSupabase();

// Supabase parses the recovery token from the URL hash automatically
// and fires a PASSWORD_RECOVERY event. Resolve when that event arrives,
// or fall back to a 1500ms timeout so we never hang.
let isRecovery = false;
await new Promise((resolve) => {
  const t = setTimeout(resolve, 1500);
  const { data: sub } = sb.auth.onAuthStateChange((event) => {
    if (event === "PASSWORD_RECOVERY") {
      isRecovery = true;
      clearTimeout(t);
      sub?.subscription?.unsubscribe?.();
      resolve();
    }
  });
});

const { data: { session } } = await sb.auth.getSession();
const form = document.getElementById("reset-form");
const noSession = document.getElementById("no-session");

if (!session) {
  noSession.classList.remove("hidden");
} else {
  form.classList.remove("hidden");
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = document.getElementById("password").value;
  const confirm = document.getElementById("confirm").value;
  const btn = document.getElementById("submit-btn");

  if (pw !== confirm) return notice("Passwords do not match", "error");
  const pwCheck = validatePassword(pw);
  if (!pwCheck.ok) return notice(pwCheck.reason, "error");

  btn.disabled = true;
  btn.textContent = "Saving…";

  const { error } = await sb.auth.updateUser({ password: pw });
  if (error) {
    notice(error.message || "Failed to update password", "error");
    btn.disabled = false;
    btn.textContent = "Set new password";
    return;
  }

  // Clear the must_change_password flag via SECURITY DEFINER RPC —
  // direct UPDATE is blocked by RLS (no self-UPDATE policy on users).
  try {
    await sb.rpc("clear_must_change_password");
  } catch (err) {
    console.warn("must_change_password clear failed:", err);
  }

  notice("Password updated", "success");
  setTimeout(() => routeAfterAuth(sb), 500);
});
