import { getSupabase } from "/js/supabase-client.js";
import { notice, routeAfterAuth, validatePassword } from "/js/shared.js";

const sb = await getSupabase();

// Two ways to arrive here with a valid session:
//  1. Code flow: forgot-password.html already called verifyOtp, so a
//     session exists immediately — no need to wait.
//  2. Link flow: Supabase parses the recovery token from the URL hash
//     and fires a PASSWORD_RECOVERY event. Wait for it, with a 1500ms
//     fallback so we never hang.
let { data: { session } } = await sb.auth.getSession();
if (!session) {
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 1500);
    const { data: sub } = sb.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        clearTimeout(t);
        sub?.subscription?.unsubscribe?.();
        resolve();
      }
    });
  });
  ({ data: { session } } = await sb.auth.getSession());
}
const form = document.getElementById("reset-form");
const noSession = document.getElementById("no-session");

if (!session) {
  // Surface the actual failure instead of a generic message. Supabase
  // reports link problems as error params in the hash (implicit flow)
  // or query string, e.g. error_code=otp_expired for a used/expired
  // token — which also happens when a corporate email scanner opens
  // the single-use link before the user does.
  const hashParams = new URLSearchParams(location.hash.replace(/^#/, ""));
  const qsParams = new URLSearchParams(location.search);
  const errCode = hashParams.get("error_code") || qsParams.get("error_code") || "";
  const errDesc = hashParams.get("error_description") || qsParams.get("error_description") || "";
  const detail = document.createElement("p");
  detail.className = "muted small";
  if (errCode === "otp_expired") {
    detail.textContent =
      "This link has expired or was already opened once. Reset links are single-use — " +
      "some email security scanners open them before you do, which uses them up. " +
      "Request a new link and open it as soon as it arrives.";
  } else if (errDesc) {
    detail.textContent = `Details: ${errDesc.replace(/\+/g, " ")} (${errCode || "unknown"})`;
  }
  if (detail.textContent) noSession.appendChild(detail);
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
