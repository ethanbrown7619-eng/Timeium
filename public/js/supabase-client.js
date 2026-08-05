// Supabase client bootstrap.
// Loads supabase-js from a locally vendored single-file bundle (no build
// step, no third-party fetch on the critical path — a CDN request inside
// the module graph used to block every page load) and reads Supabase
// URL/anon key from /config.json (served by the Cloudflare Worker).
//
// The bundle is @supabase/supabase-js@2.45.4 built with:
//   esbuild index.js --bundle --format=esm --target=es2020 --minify
// Regenerate the same way when upgrading the library version.

import { createClient } from "/js/vendor/supabase-js.js";

let _client = null;
let _config = null;

export async function getConfig() {
  if (_config) return _config;
  const res = await fetch("/config.json");
  if (!res.ok) {
    let msg = "Failed to load /config.json";
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch (err) {
      console.warn("config.json error parse failed:", err);
    }
    throw new Error(msg);
  }
  _config = await res.json();
  if (!_config.supabaseUrl || !_config.supabaseAnonKey) {
    throw new Error(
      "Supabase config missing. Set SUPABASE_URL and SUPABASE_ANON_KEY in wrangler.toml."
    );
  }
  return _config;
}

// Cross-module single sign-on: arriving from an ERP module's app-switcher,
// the URL carries a one-time magic-link token_hash (#ptl-sso=…) minted by
// this worker's /sso/mint. Exchange it for a session here and strip it.
// Runs once inside getSupabase() so every page — they all fetch the client
// before checking the session — picks it up with no per-page wiring.
let _ssoConsumed = false;
async function consumeSsoToken(client) {
  if (_ssoConsumed) return;
  _ssoConsumed = true;
  const m = /[#&]ptl-sso=([^&]+)/.exec(location.hash);
  if (!m) return;
  // Strip immediately — the one-time hash must not linger in the URL/history.
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const { data: { session } } = await client.auth.getSession();
    if (session) return; // already signed in here — let the token lapse
    await client.auth.verifyOtp({ type: "magiclink", token_hash: decodeURIComponent(m[1]) });
  } catch (err) {
    console.warn("SSO token exchange failed:", err);
  }
}

export async function getSupabase() {
  if (_client) return _client;
  const cfg = await getConfig();
  _client = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  await consumeSsoToken(_client);
  // Safety net for password-reset emails: if Supabase's redirect
  // allow-list rejects our redirect_to, the recovery link falls back to
  // the Site URL and the token lands on whatever page that is (signin,
  // index, …). detectSessionInUrl still consumes it there, so without
  // this the user just gets silently signed in and never sees the
  // set-new-password form. Whatever page catches the recovery event,
  // forward it to the reset page.
  _client.auth.onAuthStateChange((event) => {
    if (event === "PASSWORD_RECOVERY" && !location.pathname.startsWith("/reset-password")) {
      location.replace("/reset-password.html");
    }
  });
  return _client;
}
