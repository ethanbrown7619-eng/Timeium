// Cloudflare Worker entry: serves the static PWA from /public and injects
// Supabase config at /config.json so the front-end doesn't hard-code keys.
//
// Deployment model mirrors the Clock-in-out app (ethanbrown7619-eng/Clock-in-out):
// - static HTML/CSS/JS, no build step
// - Supabase anon key exposed to the browser (safe — RLS gates everything)
// - all writes go through SECURITY DEFINER RPCs or RLS-scoped policies

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

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
        }),
        {
          headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=300, must-revalidate",
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
      const response = await env.ASSETS.fetch(request);
      return addSecurityHeaders(response);
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

function addSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  // CSP allows esm.sh because supabase-js and xlsx are loaded from there.
  // 'unsafe-inline' for scripts is required by the inline <script type="module">
  // blocks on signin/signup/forgot/reset/welcome/settings/change-password pages.
  // It can be tightened once those move to external files (see audit 3.6).
  headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' https://esm.sh 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self' https://*.supabase.co https://esm.sh",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ")
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
