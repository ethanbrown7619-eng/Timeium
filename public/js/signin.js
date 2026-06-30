import { getSupabase } from "/js/supabase-client.js";
import { notice, routeAfterAuth } from "/js/shared.js";
import { mountTurnstile } from "/js/turnstile.js";

const sb = await getSupabase();
const turnstile = await mountTurnstile(document.getElementById("turnstile-container"));

// Show / hide password toggle. The button's aria-pressed state and
// label flip in sync with the input type so screen readers stay
// accurate.
document.getElementById("toggle-password").addEventListener("click", (e) => {
  const input = document.getElementById("password");
  const btn = e.currentTarget;
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  btn.setAttribute("aria-pressed", showing ? "false" : "true");
  btn.setAttribute("aria-label", showing ? "Show password" : "Hide password");
});

// Already signed in? Bounce straight through.
const { data: { session } } = await sb.auth.getSession();
if (session) {
  await routeAfterAuth(sb);
}

document.getElementById("signin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const btn = document.getElementById("submit-btn");
  btn.disabled = true;
  btn.textContent = "Signing in…";

  // Soft lockout: 5 failed attempts in 15 min blocks further tries.
  // Server-authoritative via check_login_locked RPC.
  const { data: locked } = await sb.rpc("check_login_locked", { p_email: email });
  if (locked) {
    notice("Too many failed sign-in attempts. Please wait 15 minutes and try again.", "error");
    btn.disabled = false;
    btn.textContent = "Sign in";
    return;
  }

  const captchaToken = await turnstile.getToken();
  const { data: signinData, error } = await sb.auth.signInWithPassword({
    email, password, options: { captchaToken },
  });

  // Audit the attempt. Failures go through the anon endpoint (which can
  // only ever write a failure row now); successes are recorded by an
  // authenticated RPC that derives the email server-side, so neither
  // path trusts a client-supplied success flag. Fire-and-forget.
  if (error) {
    sb.rpc("record_login_attempt", {
      p_email: email,
      p_failure_reason: error.message || null,
      p_user_agent: navigator.userAgent || null,
    }).then(() => {}, () => {});
  } else {
    sb.rpc("record_login_success").then(() => {}, () => {});
  }

  if (error) {
    notice(error.message || "Sign in failed", "error");
    turnstile.reset();
    btn.disabled = false;
    btn.textContent = "Sign in";
    return;
  }

  // Check if this user must change their default password
  const sess = signinData?.session;
  if (sess) {
    const { data: me } = await sb
      .from("users")
      .select("must_change_password")
      .eq("auth_user_id", sess.user.id)
      .maybeSingle();
    if (me?.must_change_password) {
      location.replace("/change-password.html");
      return;
    }
  }

  await routeAfterAuth(sb);
});
