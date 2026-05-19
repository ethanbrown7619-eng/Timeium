// Cloudflare Turnstile helper — renders the widget inside a target
// element and returns a getter that resolves to the latest token.
//
// Usage on signin/signup/forgot/reset pages:
//
//     import { mountTurnstile } from "/js/turnstile.js";
//     const turnstile = await mountTurnstile(document.getElementById("ts-container"));
//     ...
//     const token = await turnstile.getToken();
//     await sb.auth.signInWithPassword({ email, password,
//                                        options: { captchaToken: token } });
//     turnstile.reset();   // call after sign-in attempt so the next try
//                          // doesn't reuse the same (now-expired) token.
//
// If TURNSTILE_SITE_KEY isn't configured (env unset on the worker), the
// helper short-circuits and getToken() returns null. Supabase Auth's
// CAPTCHA enforcement is the actual gate — if the dashboard toggle is
// off, missing token is harmless; if it's on, Supabase rejects the
// signin and the user sees a clear error.

import { getConfig } from "/js/supabase-client.js";

let scriptLoadPromise = null;

function loadScript() {
  if (scriptLoadPromise) return scriptLoadPromise;
  scriptLoadPromise = new Promise((resolve, reject) => {
    if (window.turnstile) return resolve();
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Turnstile script failed to load"));
    document.head.appendChild(s);
  });
  return scriptLoadPromise;
}

export async function mountTurnstile(container) {
  const cfg = await getConfig();
  const siteKey = cfg.turnstileSiteKey;
  if (!siteKey) {
    // No CAPTCHA configured — every call is a no-op so the calling page
    // can ship its form submit unchanged.
    return { getToken: async () => null, reset: () => {} };
  }
  await loadScript();
  let latestToken = null;
  const widgetId = window.turnstile.render(container, {
    sitekey: siteKey,
    callback: (token) => { latestToken = token; },
    "error-callback": () => { latestToken = null; },
    "expired-callback": () => { latestToken = null; },
    theme: "light",
  });
  return {
    async getToken() {
      // If the widget has resolved silently we already have a token;
      // otherwise poll briefly (Managed mode usually settles in <2s).
      const deadline = Date.now() + 8000;
      while (!latestToken && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      return latestToken;
    },
    reset() {
      latestToken = null;
      try { window.turnstile.reset(widgetId); } catch { /* widget removed */ }
    },
  };
}
