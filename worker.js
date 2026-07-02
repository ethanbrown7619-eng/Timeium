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

    // Xero Payroll NZ OAuth flow. Tokens live server-side in
    // public.xero_connections; the browser never sees them.
    if (url.pathname.startsWith("/xero/")) {
      try {
        return await handleXero(url, request, env);
      } catch (err) {
        console.error("Xero handler error:", err);
        return new Response(
          JSON.stringify({ error: err.message || "Xero handler failed" }),
          { status: 500, headers: { "content-type": "application/json" } }
        );
      }
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
      "connect-src 'self' https://*.supabase.co https://esm.sh",
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

// ----------------------------------------------------------------------------
// Xero Payroll NZ integration
//
// Flow:
//   1. Admin clicks "Connect Xero" in the UI → frontend POSTs to
//      /xero/connect with Authorization: Bearer <supabase JWT> and the
//      org_id they want to link. We verify they're an admin of that org,
//      sign a state token, return the Xero authorize URL.
//   2. Frontend redirects window.location to that URL.
//   3. Xero shows the consent screen, user picks a tenant, clicks Allow.
//   4. Xero redirects to /xero/callback?code=...&state=<signed>. We
//      verify the state signature, exchange the code for tokens, look up
//      the connecting user, persist via the service role, and redirect
//      back to the admin Settings page with ?xero=connected.
// ----------------------------------------------------------------------------

// Xero Payroll NZ scopes:
//   payroll.employees  — read/write employees, leave balances, leave applications
//                        (LeaveApplications are nested under /Employees/{id}/Leave)
//   payroll.settings   — read pay items (incl. LeaveTypes for mapping)
// openid/profile/email are OIDC scopes used to identify the connecting Xero
// user. offline_access gives us the refresh token (without it, the connection
// dies after 30 min and there's no way to recover).
const XERO_SCOPES = [
  "offline_access",
  "openid",
  "profile",
  "email",
  "payroll.employees",
  "payroll.settings",
].join(" ");

const XERO_REDIRECT_PATH = "/xero/callback";
const STATE_TTL_SECONDS = 600;

async function handleXero(url, request, env) {
  switch (url.pathname) {
    case "/xero/connect":
      return xeroConnect(request, url, env);
    case "/xero/callback":
      return xeroCallback(request, url, env);
    case "/xero/api/employees":
      return xeroProxyAdmin(request, env, async (conn) => {
        // Xero Payroll paginates employees at 100/page. Loop until a
        // short page so orgs with >100 staff aren't silently truncated.
        const all = await xeroFetchAllPages(env, conn, "/payroll.xro/2.0/Employees", "employees");
        return all.map((e) => ({
          id: e.employeeID,
          firstName: e.firstName,
          lastName: e.lastName,
          email: e.email,
          status: e.endDate ? "ended" : "active",
        }));
      });
    case "/xero/api/leave-types":
      return xeroProxyAdmin(request, env, async (conn) => {
        // Xero Payroll NZ exposes leave types via /Settings. Response shape
        // varies slightly between regions — check both nesting patterns.
        const data = await xeroFetch(env, conn, "/payroll.xro/2.0/Settings");
        const types =
          data?.settings?.leaveTypes ||
          data?.settings?.payItems?.leaveTypes ||
          data?.leaveTypes ||
          [];
        return types.map((t) => ({
          id: t.leaveTypeID,
          name: t.name,
        }));
      });
    default:
      return new Response("Not found", { status: 404 });
  }
}

// Common wrapper for /xero/api/* admin routes: verify JWT, verify admin,
// resolve connection, run handler with the connection, JSON-serialise.
async function xeroProxyAdmin(request, env, handler) {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const auth = request.headers.get("Authorization") || "";
  const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!jwt) return jsonError(401, "Missing bearer token");

  const url = new URL(request.url);
  const orgId = Number(url.searchParams.get("org_id"));
  if (!Number.isInteger(orgId) || orgId <= 0) return jsonError(400, "org_id required");

  // No separate /auth/v1/user round-trip here: is_admin_of() runs with the
  // caller's JWT and PostgREST 401s on an invalid/expired session, so the
  // RPC call alone both authenticates and authorises. (xeroConnect still
  // resolves the user because it needs the sub for the state token.)
  let isAdmin;
  try {
    isAdmin = await supabaseRpc(env, jwt, "is_admin_of", { p_org_id: orgId });
  } catch {
    return jsonError(401, "Invalid session");
  }
  if (isAdmin !== true) return jsonError(403, "Not an admin of this organisation");

  const conn = await loadConnection(env, orgId);
  if (!conn) return jsonError(404, "Xero not connected for this organisation");

  try {
    const result = await handler(conn);
    return new Response(JSON.stringify(result), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (err) {
    await recordError(env, orgId, err.message || String(err));
    return jsonError(502, err.message || "Xero request failed");
  }
}

async function xeroConnect(request, url, env) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!env.XERO_CLIENT_ID || !env.XERO_CLIENT_SECRET) {
    return jsonError(500, "XERO_CLIENT_ID / XERO_CLIENT_SECRET not configured");
  }

  const auth = request.headers.get("Authorization") || "";
  const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!jwt) return jsonError(401, "Missing bearer token");

  const body = await readJson(request);
  const orgId = Number(body?.org_id);
  if (!Number.isInteger(orgId) || orgId <= 0) {
    return jsonError(400, "org_id required");
  }

  // Verify the caller is an admin of org_id by calling is_admin_of() with
  // their JWT. The RPC respects RLS — if they're not an admin, it returns
  // false and we refuse.
  const userInfo = await supabaseUser(env, jwt);
  if (!userInfo) return jsonError(401, "Invalid Supabase session");

  const isAdmin = await supabaseRpc(env, jwt, "is_admin_of", { p_org_id: orgId });
  if (isAdmin !== true) return jsonError(403, "Not an admin of this organisation");

  const stateToken = await signState(env, {
    org_id: orgId,
    sub: userInfo.sub,
    exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
    nonce: crypto.randomUUID(),
  });

  const redirectUri = `${url.origin}${XERO_REDIRECT_PATH}`;
  const authorizeUrl = new URL("https://login.xero.com/identity/connect/authorize");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", env.XERO_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", XERO_SCOPES);
  authorizeUrl.searchParams.set("state", stateToken);

  return new Response(
    JSON.stringify({ authorize_url: authorizeUrl.toString() }),
    { headers: { "content-type": "application/json", "cache-control": "no-store" } }
  );
}

async function xeroCallback(request, url, env) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    return htmlMessage(`Xero declined the connection: ${oauthError}`, 400);
  }
  if (!code || !state) {
    return htmlMessage("Missing code or state on Xero callback.", 400);
  }

  const claims = await verifyState(env, state);
  if (!claims) {
    return htmlMessage("OAuth state invalid or expired. Please retry the connection.", 400);
  }

  // Burn the state nonce so a captured state can't be replayed within its
  // TTL. First insert wins; a duplicate (already used) is rejected.
  if (!(await consumeStateNonce(env, claims.nonce))) {
    return htmlMessage("This OAuth state has already been used. Please retry the connection.", 400);
  }

  const redirectUri = `${url.origin}${XERO_REDIRECT_PATH}`;
  const tokens = await exchangeCodeForTokens(env, code, redirectUri);
  const connections = await fetchConnections(tokens.access_token);
  if (!connections.length) {
    return htmlMessage("Xero returned no tenants. The connection was not saved.", 400);
  }

  // PTL is single-tenant; if the admin authorised multiple tenants, pick
  // the first ORGANISATION (skip practice/portal entries). Document this
  // edge case for later — for now first-org wins is fine.
  const tenant =
    connections.find((c) => c.tenantType === "ORGANISATION") || connections[0];

  await persistConnection(env, {
    org_id: claims.org_id,
    sub: claims.sub,
    tenant_id: tenant.tenantId,
    tenant_name: tenant.tenantName,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    scopes: tokens.scope || XERO_SCOPES,
  });

  return Response.redirect(new URL("/configure.html?xero=connected", url), 302);
}

async function exchangeCodeForTokens(env, code, redirectUri) {
  const basic = btoa(`${env.XERO_CLIENT_ID}:${env.XERO_CLIENT_SECRET}`);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  const resp = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!resp.ok) {
    throw new Error(`Token exchange failed (${resp.status}): ${await resp.text()}`);
  }
  return resp.json();
}

async function fetchConnections(accessToken) {
  const resp = await fetch("https://api.xero.com/connections", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    throw new Error(`/connections failed (${resp.status}): ${await resp.text()}`);
  }
  return resp.json();
}

// Service-role write — bypasses RLS on xero_connections. The Worker is the
// only place we use the service key.
// Records the OAuth state nonce so it can only be used once. Returns true
// if this is the first use (inserted), false if it was already consumed
// (PostgREST 409 on the primary-key conflict). Fails open to true only if
// the nonce is missing — older tokens without one still work.
async function consumeStateNonce(env, nonce) {
  if (!nonce || !env.SUPABASE_SERVICE_ROLE_KEY) return true;
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/xero_oauth_used_states`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ nonce }),
  });
  if (resp.status === 409) return false; // already used
  return resp.ok;
}

async function persistConnection(env, row) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY not configured");
  }

  // Look up the connecting user's id (bigint) from their auth.uid (sub).
  const userResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/users?select=id&auth_user_id=eq.${encodeURIComponent(row.sub)}&limit=1`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  if (!userResp.ok) {
    throw new Error(`User lookup failed: ${await userResp.text()}`);
  }
  const userRows = await userResp.json();
  const connectedBy = userRows[0]?.id ?? null;

  // Upsert on organisation_id (which is UNIQUE on xero_connections).
  const upsert = await fetch(
    `${env.SUPABASE_URL}/rest/v1/xero_connections?on_conflict=organisation_id`,
    {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        organisation_id: row.org_id,
        tenant_id: row.tenant_id,
        tenant_name: row.tenant_name,
        access_token: row.access_token,
        refresh_token: row.refresh_token,
        token_expires_at: row.token_expires_at,
        scopes: row.scopes,
        connected_by: connectedBy,
        connected_at: new Date().toISOString(),
        last_refreshed_at: new Date().toISOString(),
        last_error: null,
        last_error_at: null,
        updated_at: new Date().toISOString(),
      }),
    }
  );
  if (!upsert.ok) {
    throw new Error(`Connection upsert failed (${upsert.status}): ${await upsert.text()}`);
  }
}

// State token: { org_id, sub, exp, nonce } signed with HMAC-SHA256 over
// the XERO_CLIENT_SECRET. Compact: base64url(payload).base64url(sig).
async function signState(env, payload) {
  const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmac(env.XERO_CLIENT_SECRET, payloadB64);
  return `${payloadB64}.${sig}`;
}

async function verifyState(env, token) {
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return null;
  const expectedSig = await hmac(env.XERO_CLIENT_SECRET, payloadB64);
  if (!constantTimeEqual(sig, expectedSig)) return null;
  let claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
  } catch {
    return null;
  }
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) return null;
  if (typeof claims.org_id !== "number" || !claims.sub) return null;
  return claims;
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64url(new Uint8Array(sig));
}

function b64url(bytes) {
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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

async function supabaseRpc(env, jwt, fn, args) {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!resp.ok) throw new Error(`RPC ${fn} failed (${resp.status}): ${await resp.text()}`);
  return resp.json();
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function htmlMessage(message, status = 200) {
  return new Response(
    `<!doctype html><html><body style="font-family:system-ui;padding:32px">
      <h1>Xero Connection</h1><p>${escapeHtml(message)}</p>
      <p><a href="/configure.html">Back to settings</a></p>
    </body></html>`,
    { status, headers: { "content-type": "text/html", "cache-control": "no-store" } }
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// ---------------------------------------------------------------------------
// xeroFetch / connection management
//
// All Xero API calls funnel through xeroFetch so token refresh + 401 retry
// are handled once. The Worker is the only place that ever holds tokens —
// the browser proxies through /xero/api/*.
// ---------------------------------------------------------------------------

async function loadConnection(env, orgId) {
  const resp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/xero_connections?organisation_id=eq.${orgId}&limit=1`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  if (!resp.ok) throw new Error(`Load connection failed: ${await resp.text()}`);
  const rows = await resp.json();
  return rows[0] || null;
}

// Page through a paginated Xero Payroll collection (100 records/page),
// concatenating the named array off each response until a short page is
// returned. Caps at 100 pages (10k records) as a runaway guard.
async function xeroFetchAllPages(env, conn, path, arrayKey) {
  const out = [];
  for (let page = 1; page <= 100; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const data = await xeroFetch(env, conn, `${path}${sep}page=${page}`);
    const chunk = data?.[arrayKey] || [];
    out.push(...chunk);
    if (chunk.length < 100) break;
  }
  return out;
}

async function xeroFetch(env, conn, path, init = {}) {
  let access = await ensureFreshToken(env, conn);

  const call = (token) =>
    fetch(`https://api.xero.com${path}`, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${token}`,
        "Xero-Tenant-Id": conn.tenant_id,
        Accept: "application/json",
      },
    });

  let resp = await call(access);

  // 401 → token revoked or stale despite expires_at. Force-refresh once.
  if (resp.status === 401) {
    access = await refreshConnection(env, conn);
    resp = await call(access);
  }

  if (!resp.ok) {
    throw new Error(`Xero ${path} (${resp.status}): ${(await resp.text()).slice(0, 500)}`);
  }
  return resp.json();
}

// If the stored access token has < 60s left, refresh before use. Avoids the
// race where we make a call right as the token expires.
async function ensureFreshToken(env, conn) {
  const expiresAt = new Date(conn.token_expires_at).getTime();
  if (expiresAt - Date.now() > 60_000) return conn.access_token;
  return refreshConnection(env, conn);
}

// Refresh the access token. Xero rotates the refresh token on every call,
// so we MUST persist the new refresh_token immediately — the old one is
// invalidated and a second refresh attempt with it would break the
// connection permanently.
async function refreshConnection(env, conn) {
  const basic = btoa(`${env.XERO_CLIENT_ID}:${env.XERO_CLIENT_SECRET}`);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: conn.refresh_token,
  });
  const resp = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text();
    await recordError(env, conn.organisation_id, `Refresh failed: ${text.slice(0, 400)}`);
    throw new Error(`Token refresh failed (${resp.status}): ${text}`);
  }
  const tokens = await resp.json();

  // Persist before returning — if persistence fails we'd rather throw than
  // hand back tokens we can't replay later.
  await persistRefresh(env, conn.organisation_id, tokens);
  conn.access_token = tokens.access_token;
  conn.refresh_token = tokens.refresh_token;
  conn.token_expires_at = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  return tokens.access_token;
}

async function persistRefresh(env, orgId, tokens) {
  const resp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/xero_connections?organisation_id=eq.${orgId}`,
    {
      method: "PATCH",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
        last_refreshed_at: new Date().toISOString(),
        last_error: null,
        last_error_at: null,
        updated_at: new Date().toISOString(),
      }),
    }
  );
  if (!resp.ok) throw new Error(`Refresh persist failed: ${await resp.text()}`);
}

async function recordError(env, orgId, message) {
  try {
    await fetch(
      `${env.SUPABASE_URL}/rest/v1/xero_connections?organisation_id=eq.${orgId}`,
      {
        method: "PATCH",
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          last_error: message.slice(0, 1000),
          last_error_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      }
    );
  } catch {
    // Best-effort: a failure to log shouldn't mask the real error.
  }
}
