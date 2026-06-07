import { getSupabase } from "/js/supabase-client.js";
import { notice } from "/js/shared.js";
import { mountTurnstile } from "/js/turnstile.js";

const sb = await getSupabase();
const turnstile = await mountTurnstile(document.getElementById("turnstile-container"));

document.getElementById("forgot-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("email").value.trim();
  const btn = document.getElementById("submit-btn");

  if (!email) return notice("Enter your email address", "error");

  btn.disabled = true;
  btn.textContent = "Sending…";

  const redirectTo = `${location.origin}/reset-password.html`;
  const captchaToken = await turnstile.getToken();
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo, captchaToken });

  if (error) {
    notice(error.message || "Failed to send reset email", "error");
    turnstile.reset();
    btn.disabled = false;
    btn.textContent = "Send reset link";
    return;
  }

  // Always show success (don't leak whether email exists)
  document.getElementById("forgot-form").style.display = "none";
  notice(
    "If an account exists for that email, a password reset link has been sent. Check your inbox.",
    "success"
  );
});
