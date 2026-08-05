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

  // Soft lockout pre-check: 5 authoritative failures in 15 min. This is a
  // courtesy message, NOT a control — it only reports what the migration
  // 142 auth hook recorded, and that hook is Team/Enterprise-only and is
  // not currently enabled, so today this always returns false. The real
  // brute-force controls are Supabase's per-IP auth rate limiting and
  // Turnstile CAPTCHA enforcement (Authentication -> Attack Protection).
  // Best-effort: a network blip on this courtesy check must NOT strand the
  // button on "Signing in…" — treat any failure as "not locked" and proceed
  // to the real sign-in, which surfaces its own errors.
  let locked = false;
  try {
    ({ data: locked } = await sb.rpc("check_login_locked", { p_email: email }));
  } catch { /* proceed as not-locked */ }
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

  // Attempt logging (migration 162). Rows written from here are stamped
  // source='client' and are FORENSICS ONLY — check_login_locked counts
  // only source='auth_hook' rows, written inside the auth server by the
  // migration 142 hook. That split is deliberate: this endpoint is
  // anon-callable, so if it could move the lockout, anyone could lock out
  // any employee by posting failures for their address.
  //
  // Logging must never break a sign-in, so every call is best-effort.
  // NOTE: sb.rpc() returns a PostgrestBuilder THENABLE, not a Promise — it
  // has .then() but no .catch() in the vendored supabase-js. Calling .catch
  // on it threw a TypeError that killed this handler right after a
  // successful sign-in, leaving the button on "Signing in…" until a manual
  // refresh (the session was already saved). await-in-try is the safe shape.
  const logAttempt = async (fn, args) => {
    try { await sb.rpc(fn, args); } catch { /* best effort */ }
  };

  if (error) {
    logAttempt("record_login_attempt", {
      p_email: email,
      p_failure_reason: error.message || "sign_in_failed",
      p_user_agent: navigator.userAgent,
    });
    notice(error.message || "Sign in failed", "error");
    turnstile.reset();
    btn.disabled = false;
    btn.textContent = "Sign in";
    return;
  }

  // Success path: the RPC derives the email from auth.uid() server-side,
  // so it can't be fabricated for another account.
  logAttempt("record_login_success", {});

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
