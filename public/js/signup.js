import { getSupabase } from "/js/supabase-client.js";
import { notice, routeAfterAuth, validatePassword } from "/js/shared.js";
import { mountTurnstile } from "/js/turnstile.js";

const sb = await getSupabase();
const turnstile = await mountTurnstile(document.getElementById("turnstile-container"));

// Already signed in? Skip straight to the router.
const { data: { session } } = await sb.auth.getSession();
if (session) {
  await routeAfterAuth(sb);
}

document.getElementById("signup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const btn = document.getElementById("submit-btn");
  const pwCheck = validatePassword(password);
  if (!pwCheck.ok) return notice(pwCheck.reason, "error");
  btn.disabled = true;
  btn.textContent = "Creating account…";

  const captchaToken = await turnstile.getToken();
  const { data, error } = await sb.auth.signUp({
    email, password, options: { captchaToken },
  });
  if (error) {
    notice(error.message || "Sign up failed", "error");
    turnstile.reset();
    btn.disabled = false;
    btn.textContent = "Sign up";
    return;
  }

  // If email confirmation is ON in Supabase, signUp returns session=null.
  // Tell the user to check their inbox and stop here.
  if (!data.session) {
    notice(
      "Account created. Check your email to confirm, then sign in.",
      "success",
      { sticky: true }
    );
    btn.disabled = false;
    btn.textContent = "Sign up";
    return;
  }

  // Session is live — try to claim an employee row.
  await routeAfterAuth(sb);
});
