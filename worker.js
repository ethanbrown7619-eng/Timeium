// Cloudflare Worker entry: serves the static PWA from /public and injects
// Supabase config at /config.json so the front-end doesn't hard-code keys.
//
// Deployment model mirrors the Clock-in-out app (ethanbrown7619-eng/Clock-in-out):
// - static HTML/CSS/JS, no build step
// - Supabase anon key exposed to the browser (safe — RLS gates everything)
// - all writes go through SECURITY DEFINER RPCs or RLS-scoped policies

// ISO 3166 country codes refused at the edge per IT direction. Cloudflare
// attaches request.cf.country to every request (browser-facing requests
// only — won't be set when Wrangler runs locally, hence the guard). 451
// = Unavailable For Legal Reasons, which is the correct status for
// geographic restrictions and what most CDNs use here.
const BLOCKED_COUNTRIES = new Set(["RU", "CN", "NG"]);

export default {
  async fetch(request, env, ctx) {
    const country = request.cf?.country;
    if (country && BLOCKED_COUNTRIES.has(country)) {
      return new Response(
        "Access to this service is not available from your region.",
        { status: 451, headers: { "content-type": "text/plain" } },
      );
    }

    const url = new URL(request.url);

    // Cross-module single sign-on mint. A signed-in ERP module presents its
    // user's JWT and gets back a one-time magic-link token_hash; the
    // destination module exchanges it (verifyOtp) for its OWN session with
    // its own refresh-token family — never a shared/copied token, so
    // Supabase's refresh-token reuse detection can't revoke anything.
    if (url.pathname === "/sso/mint") {
      try {
        return await handleSsoMint(request, env);
      } catch (err) {
        console.error("SSO mint error:", err);
        return new Response(JSON.stringify({ error: "mint failed" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    }

    // The Xero Payroll integration was ARCHIVED 2026-08-05 (unused; its
    // worker secrets were never restored after the worker was recreated).
    // Full code at git tag archive/xero-integration; its DB objects
    // (public.xero_connections, migrations 112-114/143) remain in place.
    if (url.pathname.startsWith("/xero/")) {
      return new Response(
        JSON.stringify({ error: "The Xero integration is archived (tag archive/xero-integration)." }),
        { status: 410, headers: { "content-type": "application/json" } }
      );
    }

    if (url.pathname === "/config.json") {
      if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
        return new Response(
          JSON.stringify({
            error:
              "Server configuration missing — SUPABASE_URL and SUPABASE_ANON_KEY must be set in wrangler.toml or as worker secrets.",
          }),
          {
            status: 500,
            headers: {
              "content-type": "application/json",
              "cache-control": "no-store",
            },
          }
        );
      }
      return new Response(
        JSON.stringify({
          supabaseUrl: env.SUPABASE_URL,
          supabaseAnonKey: env.SUPABASE_ANON_KEY,
          // Cloudflare Turnstile site key. Public, safe to expose. The
          // signin/signup/forgot/reset pages render the widget only when
          // a key is present; missing key = CAPTCHA disabled gracefully.
          turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null,
        }),
        {
          headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=300",
          },
        }
      );
    }

    // Redirect favicon.ico to the SVG so browser/OS shortcut flows that
    // hard-request /favicon.ico still get a real icon instead of nothing.
    if (url.pathname === "/favicon.ico") {
      return Response.redirect(new URL("/favicon.svg", url), 301);
    }

    // Everything else falls through to the static assets binding.
    try {
      // Guard the exact failure that once 503'd the site: env.ASSETS only
      // exists when wrangler.toml declares `binding = "ASSETS"` under
      // [assets]. Fail loudly and specifically, never as a mystery 503.
      if (!env.ASSETS) {
        console.error('env.ASSETS is undefined — declare binding = "ASSETS" under [assets] in wrangler.toml');
        return new Response("Server misconfiguration: assets binding missing.", {
          status: 500,
          headers: { "content-type": "text/plain", "cache-control": "no-store" },
        });
      }
      const response = await env.ASSETS.fetch(request);
      // Header decoration must never take the site down: if it throws
      // for any reason, serve the asset undecorated rather than 503.
      try {
        return addSecurityHeaders(response, url.pathname);
      } catch (err) {
        console.error("Header decoration failed:", err);
        return response;
      }
    } catch (err) {
      console.error("Asset fetch failed:", err);
      return new Response(
        "<!doctype html><html><body><h1>Service temporarily unavailable</h1>" +
          "<p>Please refresh the page in a moment.</p></body></html>",
        {
          status: 503,
          headers: {
            "content-type": "text/html",
            "cache-control": "no-store",
          },
        }
      );
    }
  },
};

// Per-type cache policy. HTML and unhashed JS/CSS use no-cache so every
// load revalidates (a cheap 304 via the assets binding's ETag) — a
// max-age window on unhashed ES modules could pair a stale shared.js
// with a fresh page module right after a deploy and break every import.
// Long-lived media (icons, images, fonts) cache for 7 days; rename the
// file when it changes.
function cacheControlFor(pathname) {
  if (/\.(png|jpe?g|gif|webp|ico|svg|woff2?)$/i.test(pathname)) {
    return "public, max-age=604800";
  }
  return "no-cache";
}

// IMPORTANT: with run_worker_first off (see wrangler.toml), this function
// only decorates the SPA-fallback path — Cloudflare's asset layer serves
// every real page/script/style without invoking the Worker at all. The
// headers that actually reach browsers on those responses come from
// public/_headers, which carries an identical copy. Change both, or
// neither. (Security audit 2026-08, finding A1.)
function addSecurityHeaders(response, pathname) {
  const headers = new Headers(response.headers);
  if (pathname) headers.set("Cache-Control", cacheControlFor(pathname));
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  // CSP allows esm.sh for the LAZY export libraries only (xlsx, jspdf —
  // dynamically imported when an admin clicks an export button).
  // supabase-js itself is vendored locally (js/vendor/supabase-js.js) so
  // no third-party fetch sits on the page-load critical path.
  // All page scripts live in external /js/*.js files so script-src can
  // refuse 'unsafe-inline' — meaningful XSS containment, since an
  // injected <script>…</script> would now be blocked by the browser.
  // style-src still allows 'unsafe-inline' because the templates use
  // inline style="…" attributes throughout; tightening that would
  // require a much larger refactor.
  headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      // challenges.cloudflare.com hosts the Turnstile widget script.
      "script-src 'self' https://esm.sh https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self' https://*.supabase.co https://esm.sh https://challenges.cloudflare.com",
      // Turnstile renders its challenge UI inside an iframe served from
      // challenges.cloudflare.com.
      "frame-src https://challenges.cloudflare.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ")
  );
  // 101/204/205/304 are null-body statuses: constructing a Response for
  // them with a (even empty) body stream throws a TypeError. With
  // run_worker_first + no-cache, 304 revalidations now flow through here
  // constantly — reconstructing them with response.body was 503ing every
  // page load that hit the browser's ETag cache.
  const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);
  return new Response(
    NULL_BODY_STATUS.has(response.status) ? null : response.body,
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    }
  );
}

// ---------------------------------------------------------------- SSO mint --
// POST /sso/mint  (Authorization: Bearer <caller's Supabase access token>)
// → { token_hash }
//
// Called by the ERP module apps' app-switchers (cross-origin, hence CORS).
// The caller proves who they are with their own JWT; the mint is always for
// that same user — the endpoint can't mint for anyone else. The returned
// token_hash is a standard GoTrue one-time magic-link hash: the destination
// module calls supabase.auth.verifyOtp({ type: "magiclink", token_hash })
// and receives a fresh, independent session. No email is sent.
// Both Cloudflare accounts serve PTL apps: the ERP modules live on
// ethanbrown7619.workers.dev and the production Timesheet mirror on
// businessautomation.workers.dev (ptl-timesheet).
const SSO_ORIGIN_RE = /^https:\/\/[a-z0-9-]+\.(ethanbrown7619|businessautomation)\.workers\.dev$/;

function ssoCorsHeaders(origin) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

async function handleSsoMint(request, env) {
  const origin = request.headers.get("Origin") || "";
  // Same-origin (Timesheet's own switcher) sends no Origin on same-origin
  // fetches in some browsers; cross-origin must match the workers.dev fleet.
  if (origin && !SSO_ORIGIN_RE.test(origin)) {
    return new Response("forbidden origin", { status: 403 });
  }
  const cors = origin ? ssoCorsHeaders(origin) : {};

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: cors });
  }
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: "sso not configured" }), {
      status: 503,
      headers: { "content-type": "application/json", ...cors },
    });
  }

  const auth = request.headers.get("Authorization") || "";
  const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const user = jwt ? await supabaseUser(env, jwt) : null;
  if (!user?.email) {
    return new Response(JSON.stringify({ error: "not authenticated" }), {
      status: 401,
      headers: { "content-type": "application/json", ...cors },
    });
  }

  const resp = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "magiclink", email: user.email }),
  });
  if (!resp.ok) {
    console.error("generate_link failed:", resp.status, await resp.text());
    return new Response(JSON.stringify({ error: "mint failed" }), {
      status: 502,
      headers: { "content-type": "application/json", ...cors },
    });
  }
  const link = await resp.json();
  const tokenHash = link?.hashed_token ?? link?.properties?.hashed_token ?? null;
  if (!tokenHash) {
    console.error("generate_link: no hashed_token in response");
    return new Response(JSON.stringify({ error: "mint failed" }), {
      status: 502,
      headers: { "content-type": "application/json", ...cors },
    });
  }
  return new Response(JSON.stringify({ token_hash: tokenHash }), {
    headers: { "content-type": "application/json", "cache-control": "no-store", ...cors },
  });
}

// Verify a Supabase JWT by calling /auth/v1/user. Returns the decoded
// user object (with .sub = auth.uid) or null. Doing it this way means we
// don't have to verify signatures locally — Supabase enforces it.
async function supabaseUser(env, jwt) {
  const resp = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${jwt}` },
  });
  if (!resp.ok) return null;
  const user = await resp.json();
  return user?.id ? { sub: user.id, email: user.email } : null;
}

