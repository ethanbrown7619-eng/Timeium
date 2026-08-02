import { getSupabase } from "/js/supabase-client.js";
import { notice } from "/js/shared.js";
import { mountTurnstile } from "/js/turnstile.js";

const sb = await getSupabase();
const turnstile = await mountTurnstile(document.getElementById("turnstile-container"));

const forgotForm = document.getElementById("forgot-form");
const codeForm = document.getElementById("code-form");
let sentEmail = "";

forgotForm.addEventListener("submit", async (e) => {
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
    btn.textContent = "Email me a code";
    return;
  }

  // Always proceed to the code step (don't leak whether email exists)
  sentEmail = email;
  forgotForm.style.display = "none";
  document.getElementById("intro-text").textContent =
    "If an account exists for that email, we've sent a 6-digit code. Enter it below.";
  codeForm.classList.remove("hidden");
  document.getElementById("code").focus();
});

codeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = document.getElementById("code").value.trim();
  const btn = document.getElementById("verify-btn");

  if (!/^\d{6}$/.test(code)) return notice("Enter the 6-digit code from the email", "error");

  btn.disabled = true;
  btn.textContent = "Verifying…";

  const { error } = await sb.auth.verifyOtp({ email: sentEmail, token: code, type: "recovery" });

  if (error) {
    notice(
      "That code is incorrect or has expired. Make sure you're using the code from the " +
        "newest email, or request a new one.",
      "error"
    );
    btn.disabled = false;
    btn.textContent = "Verify code";
    return;
  }

  // verifyOtp established a session; reset-password.html will show the
  // set-password form when it finds one.
  location.assign("/reset-password.html");
});
