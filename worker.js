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
      return new Response(
        JSON.stringify({
          supabaseUrl: env.SUPABASE_URL || "",
          supabaseAnonKey: env.SUPABASE_ANON_KEY || "",
        }),
        {
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
          },
        }
      );
    }

    // Everything else falls through to the static assets binding.
    return env.ASSETS.fetch(request);
  },
};
