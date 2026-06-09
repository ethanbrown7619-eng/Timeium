// Xero OAuth 2.0 helper — gets an access token, refresh token, and tenant ID
// from the Xero Demo Company so we can hit the Payroll NZ API against fake
// data. Throwaway prototype — not the real Worker integration.
//
// Run:  node --env-file=.env xero-auth.js
//
// Flow:
//   1. Print the authorize URL — you open it in a browser and click "Allow"
//      against Demo Company.
//   2. Xero redirects to http://localhost:8787/xero/callback with a code.
//   3. This script's tiny HTTP server catches the code, exchanges it for
//      tokens, fetches the tenant ID, and writes everything to tokens.json.

import http from "node:http";
import crypto from "node:crypto";
import { writeFileSync } from "node:fs";

const CLIENT_ID = process.env.XERO_CLIENT_ID;
const CLIENT_SECRET = process.env.XERO_CLIENT_SECRET;
const REDIRECT_URI = "http://localhost:8787/xero/callback";
const PORT = 8787;

const SCOPES = [
  "offline_access",
  "openid",
  "profile",
  "email",
  "accounting.settings.read",
  "payroll.employees",
  "payroll.leaveapplications",
  "payroll.payitems",
].join(" ");

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing XERO_CLIENT_ID or XERO_CLIENT_SECRET — copy .env.example to .env and fill it in.");
  process.exit(1);
}

const state = crypto.randomBytes(16).toString("hex");

const authorizeUrl = new URL("https://login.xero.com/identity/connect/authorize");
authorizeUrl.searchParams.set("response_type", "code");
authorizeUrl.searchParams.set("client_id", CLIENT_ID);
authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authorizeUrl.searchParams.set("scope", SCOPES);
authorizeUrl.searchParams.set("state", state);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== "/xero/callback") {
    res.writeHead(404);
    res.end("not found");
    return;
  }

  const returnedState = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(400, { "content-type": "text/html" });
    res.end(`<h1>Xero returned an error</h1><p>${error}</p>`);
    console.error("Xero error:", error);
    server.close();
    return;
  }

  if (returnedState !== state) {
    res.writeHead(400);
    res.end("state mismatch — possible CSRF, refusing to continue");
    console.error("State mismatch. Expected", state, "got", returnedState);
    server.close();
    return;
  }

  if (!code) {
    res.writeHead(400);
    res.end("no code in callback");
    server.close();
    return;
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    const connections = await fetchConnections(tokens.access_token);

    const result = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
      obtained_at: new Date().toISOString(),
      scope: tokens.scope,
      connections,
    };

    writeFileSync("tokens.json", JSON.stringify(result, null, 2));

    res.writeHead(200, { "content-type": "text/html" });
    res.end(`
      <h1>Xero connected</h1>
      <p>Tokens written to <code>tokens.json</code>. You can close this tab.</p>
      <pre>${JSON.stringify(connections, null, 2)}</pre>
    `);

    console.log("\nSUCCESS — tokens.json written");
    console.log("Tenants you authorised:");
    for (const c of connections) {
      console.log(`  - ${c.tenantName} (tenantId: ${c.tenantId}, type: ${c.tenantType})`);
    }
    console.log("\nNext: run other scripts against the tenant whose name is 'Demo Company (NZ)'.");

    server.close();
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`Token exchange failed: ${err.message}`);
    console.error(err);
    server.close();
  }
});

async function exchangeCodeForTokens(code) {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
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
    throw new Error(`token endpoint ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
}

async function fetchConnections(accessToken) {
  const resp = await fetch("https://api.xero.com/connections", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    throw new Error(`/connections ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
}

server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
  console.log("\nOpen this URL in your browser and click 'Allow access' on the Demo Company:\n");
  console.log(authorizeUrl.toString());
  console.log("");
});
