import { getSupabase, getConfig } from "/js/supabase-client.js";
import { notice, routeAfterAuth } from "/js/shared.js";
import { mountTurnstile } from "/js/turnstile.js";

// Read the OAuth return markers BEFORE the client boots. getSupabase()
// creates the client with detectSessionInUrl, which consumes and strips
// them during initialisation — read them afterwards and they're always
// gone. Declared above the boot await deliberately: a const read from
// inside that await would still be in its temporal dead zone.
const _returnUrl  = new URL(location.href);
const _returnHash = new URLSearchParams(location.hash.replace(/^#/, ""));
const RETURNED_FROM_OAUTH =
  _returnHash.has("access_token") || _returnUrl.searchParams.has("code");
// Microsoft reports failures on the way back rather than on the way out —
// consent declined, user not assigned to the app, a bad client secret.
const OAUTH_ERROR =
  _returnUrl.searchParams.get("error_description") ||
  _returnUrl.searchParams.get("error") ||
  _returnHash.get("error_description") ||
  _returnHash.get("error") ||
  null;

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

if (OAUTH_ERROR) {
  notice(`Microsoft sign-in failed: ${OAUTH_ERROR}`, "error");
  // Strip it so a refresh doesn't re-show the same error forever.
  history.replaceState(null, "", location.pathname);
}

// Already signed in? Bounce straight through. This is also the landing
// point for a Microsoft sign-in: detectSessionInUrl has already turned the
// returned tokens into a session by the time getSession() resolves.
const { data: { session } } = await sb.auth.getSession();
if (session) {
  // Keep the audit trail complete — the password path logs this from its
  // own success branch, and an Entra sign-in never goes through there.
  if (RETURNED_FROM_OAUTH) {
    try { await sb.rpc("record_login_success", {}); } catch { /* best effort */ }
  }
  await routeAfterAuth(sb);
}

// ---- Microsoft / Entra ----------------------------------------------------
// The button is revealed only when the worker says the provider is
// configured, so it cannot exist before there's a real client secret behind
// it. Neither Turnstile nor the lockout pre-check applies here: both guard
// against password guessing, and this path has no password. Microsoft owns
// the credential, the MFA prompt and its own lockout.
try {
  const cfg = await getConfig();
  const block = document.getElementById("entra-block");
  const entraBtn = document.getElementById("entra-btn");
  if (cfg.entraEnabled && block && entraBtn) {
    block.hidden = false;
    entraBtn.addEventListener("click", async () => {
      entraBtn.disabled = true;
      // Returns here, where the block above picks the session up.
      const { error } = await sb.auth.signInWithOAuth({
        provider: "azure",
        options: {
          scopes: "openid email profile",
          redirectTo: `${location.origin}/signin.html`,
        },
      });
      // Only reached if the redirect never happened — otherwise the page
      // is already on its way to Microsoft.
      if (error) {
        notice(error.message || "Could not start Microsoft sign-in", "error");
        entraBtn.disabled = false;
      }
    });
  }
} catch (err) {
  // Config unavailable: leave the button hidden. Password sign-in below is
  // unaffected, so this must never throw the page away.
  console.warn("Entra button setup skipped:", err);
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
