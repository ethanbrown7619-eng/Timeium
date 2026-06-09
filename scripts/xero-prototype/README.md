# Xero Prototype

Throwaway scripts for proving the Xero Payroll NZ integration against the
Demo Company before wiring it into the real timesheet app.

## Setup (once)

1. Copy `.env.example` to `.env`:
   ```
   cp .env.example .env
   ```
2. Fill in `XERO_CLIENT_ID` and `XERO_CLIENT_SECRET` from your app at
   developer.xero.com → My Apps → PTL Timesheet Integration (dev) → Configuration.

`.env` is gitignored — credentials never leave your machine.

## Get tokens

```
node --env-file=.env xero-auth.js
```

This:
1. Starts a tiny HTTP server on `http://localhost:8787`
2. Prints a Xero authorize URL — open it in your browser
3. You click **Allow access** against **Demo Company (NZ)**
4. Xero redirects back, the script catches the code, exchanges it for tokens,
   and writes `tokens.json` (also gitignored)

## What's in tokens.json

- `access_token` — use as `Authorization: Bearer …`, expires in 30 minutes
- `refresh_token` — exchange for a new access token, rotates on every use,
  valid 60 days from last use
- `connections[]` — list of Xero tenants you authorised. Each entry has a
  `tenantId` (GUID) which you pass as the `Xero-Tenant-Id` header on every
  API call

## Make a test call

After running `xero-auth.js`, grab the access token and tenant ID from
`tokens.json` and try:

```
curl -H "Authorization: Bearer <access_token>" \
     -H "Xero-Tenant-Id: <tenantId>" \
     https://api.xero.com/payroll.xro/2.0/Employees
```

Should return the demo employees as JSON.

## Files

- `xero-auth.js` — OAuth round-trip, writes tokens.json
- `tokens.json` — gitignored, regenerate any time by re-running auth
- `.env` — gitignored, your client credentials
