// Supabase Edge Function: send-timesheet-notifications
// -----------------------------------------------------------------------------
// Mirrors the pattern of Attendium's send-weekly-flags (different repo, same
// Supabase project). Runs every 15 minutes (pg_cron -> net.http_post). For
// each organisation:
//
//   * If notify_reminder is on and the current local day/time matches the
//     org's reminder_day / reminder_time (or reminder_day_2 / reminder_time_2),
//     emails every ACTIVE employee whose timesheet for the current week is
//     not yet submitted, asking them to submit before the deadline.
//
//   * If notify_overdue is on and the current local day/time matches the
//     org's overdue_day / overdue_time, emails the previous week's overdue
//     digest. Recipient set is governed by notify_overdue_recipient:
//        'employee' = each overdue employee individually
//        'admins'   = every org admin gets the full overdue list
//        'both'     = both of the above
//
//   * If notify_discrepancy is on and the current local day/time matches the
//     org's discrepancy_day / discrepancy_time, calls Attendium's
//     weekly_timesheet RPC for the previous week, compares clocked hours to
//     timesheet_entries-summed hours, and emails every org admin a digest
//     of employees whose diff exceeds clock_tolerance_hours.
//
// Each notification has its own *_last_sent_at column on organisations for
// dedup; same-local-day re-runs skip.
//
// Required Supabase edge function secrets:
//   SMTP_HOST                    e.g. "mail-au.smtp2go.com"
//   SMTP_PORT                    e.g. "2525"
//   SMTP_USER                    SMTP relay username (often the sender email)
//   SMTP_PASS                    SMTP relay password
//   NOTIFY_FROM                  e.g. "PTL Time Sheet <clockapp@ptlmachinery.com>"
//   APP_BASE_URL                 e.g. "https://ptl-timesheet.<...>.workers.dev"
//   SUPABASE_URL                 auto-populated
//   SUPABASE_SERVICE_ROLE_KEY    auto-populated
//
// Manual trigger for testing:
//   curl -X POST https://<project>.supabase.co/functions/v1/send-timesheet-notifications \
//        -H "Authorization: Bearer <service-role>" \
//        -H "Content-Type: application/json" \
//        -d '{"force_org_id": 1, "force_kind": "reminder"}'
//
// force_kind ∈ ('reminder','reminder_2','overdue','discrepancy') bypasses
// the day/time check and dedup for that org+kind. Useful for smoke tests.

// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient }   from "https://deno.land/x/denomailer@1.6.0/mod.ts";

// SMTP defaults pulled from env. Each org row may override these by
// populating organisations.smtp_* — when present those win, otherwise
// the function falls back to whatever was set as edge-function secrets
// at deploy time. Letting orgs own their own config means the Configure
// page can manage credentials without touching wrangler or Supabase
// dashboard secrets.
const SMTP_HOST    = Deno.env.get("SMTP_HOST");
const SMTP_PORT    = Number(Deno.env.get("SMTP_PORT") ?? "2525");
const SMTP_USER    = Deno.env.get("SMTP_USER");
const SMTP_PASS    = Deno.env.get("SMTP_PASS");
const NOTIFY_FROM  = Deno.env.get("NOTIFY_FROM") ?? "PTL Time Sheet <clockapp@ptlmachinery.com>";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_BASE_URL = Deno.env.get("APP_BASE_URL") ?? "https://ptl-timesheet.workers.dev";

// When set, every email is redirected to this address regardless of who
// it was meant for. Original recipient is preserved in the subject prefix
// and at the top of the HTML body so you can verify the routing logic
// without spamming real users. Leave unset in production.
const DEBUG_REDIRECT_EMAIL = Deno.env.get("DEBUG_REDIRECT_EMAIL");

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

// denomailer queues SMTP commands and rejects on a microtask tick AFTER
// the awaited send() returns. If we don't capture the rejection globally
// the Deno worker crashes (Supabase returns 503, browser sees no CORS
// header). Stash the latest async SMTP error so the test-send branch can
// surface it in the response body instead of dying silently.
let lastAsyncSmtpError: string | null = null;
addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    const msg = String((e.reason as { message?: string } | undefined)?.message ?? e.reason);
    console.error("unhandled rejection (likely denomailer):", msg);
    lastAsyncSmtpError = msg;
    e.preventDefault();
});

// ---------------------------------------------------------------------------
// Date helpers (mirrors Attendium's send-weekly-flags conventions)
// ---------------------------------------------------------------------------

function localDate(tz: string, date = new Date()): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(date);
}
function localDayName(tz: string, date = new Date()): string {
    return new Intl.DateTimeFormat("en-US",
        { timeZone: tz, weekday: "long" }).format(date).toLowerCase();
}
function localHour(tz: string, date = new Date()): number {
    const h = new Intl.DateTimeFormat("en-GB",
        { timeZone: tz, hour: "2-digit", hour12: false }).format(date);
    const n = parseInt(h, 10);
    return n === 24 ? 0 : n;
}
function localMinute(tz: string, date = new Date()): number {
    const m = new Intl.DateTimeFormat("en-GB",
        { timeZone: tz, minute: "2-digit" }).format(date);
    return parseInt(m, 10) || 0;
}
function addDaysIso(iso: string, n: number): string {
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return dt.toISOString().slice(0, 10);
}
function mondayOf(tz: string, date = new Date()): string {
    const dayName = localDayName(tz, date);
    const idx = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"].indexOf(dayName);
    return addDaysIso(localDate(tz, date), -idx);
}
function formatDate(iso: string): string {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
}

// Parse a "HH:MM" or "HH:MM:SS" string -> number of minutes since midnight.
function parseTimeToMinutes(t: string | null): number | null {
    if (!t) return null;
    const [h, m] = t.split(":").map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return h * 60 + m;
}

// ---------------------------------------------------------------------------
// Time-slot match. The cron fires every 15 minutes. A notification slot is
// "active" if the local time is within a 15-minute window starting at the
// configured hh:mm. e.g. reminder_time = 09:00 fires for any cron run at
// 09:00..09:14 local. The dedup column then prevents the same slot from
// firing twice in one local day.
// ---------------------------------------------------------------------------

function slotMatches(tz: string, configuredDay: string | null,
                     configuredTime: string | null, now: Date): boolean {
    if (!configuredDay || !configuredTime) return false;
    if (localDayName(tz, now) !== configuredDay.toLowerCase()) return false;
    const configuredMin = parseTimeToMinutes(configuredTime);
    if (configuredMin == null) return false;
    const nowMin = localHour(tz, now) * 60 + localMinute(tz, now);
    const diff = nowMin - configuredMin;
    return diff >= 0 && diff < 15;
}

function alreadySentToday(tz: string, lastSentAt: string | null, now: Date): boolean {
    if (!lastSentAt) return false;
    return localDate(tz, new Date(lastSentAt)) === localDate(tz, now);
}

function escapeHtml(s: any): string {
    return String(s ?? "").replace(/[&<>"']/g, c => ({
        "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;",
    } as Record<string,string>)[c]);
}

// ---------------------------------------------------------------------------
// SMTP sender (denomailer over SMTP relay)
// ---------------------------------------------------------------------------
// One client per HTTP invocation: we open at the start of the handler, send
// every email through it (re-using the TCP/TLS connection), then close at
// the end. Closing isn't optional - leaving the socket open will keep the
// Deno process alive past the response and time out the function.

// SMTP config is resolved per-org: organisations.smtp_* overrides the
// env-secret fallback. processOrg() calls openSmtpFor(org) before firing
// any sends and closeSmtpClient() in finally — that way each tenant uses
// its own credentials and the TCP socket is released between orgs.
//
// State is module-level (rather than threaded through every fire* and
// sendEmail call) purely to keep the diff narrow. Don't call sendEmail
// without openSmtpFor() preceding it in the same scope.

interface SmtpConfig {
    host: string; port: number; user: string; pass: string; from: string;
}

let smtpClient: SMTPClient | null = null;
let smtpFrom: string = NOTIFY_FROM;
// Per-invocation debug redirect — populated from organisations.debug_redirect_email
// at the top of processOrg. Falls back to DEBUG_REDIRECT_EMAIL env var when null.
let currentDebugRedirect: string | null = null;

function resolveSmtpConfig(org: any): SmtpConfig {
    const host = (org?.smtp_host as string) || SMTP_HOST || "";
    const portRaw = org?.smtp_port ?? null;
    const port = portRaw ? Number(portRaw) : SMTP_PORT;
    const user = (org?.smtp_user as string) || SMTP_USER || "";
    const pass = (org?.smtp_pass as string) || SMTP_PASS || "";
    const from = (org?.smtp_from as string) || NOTIFY_FROM;
    if (!host || !user || !pass) {
        throw new Error(
            "SMTP not configured for this org and no fallback secret set. " +
            "Populate organisations.smtp_* via the Configure page or set " +
            "SMTP_HOST / SMTP_USER / SMTP_PASS on the edge function.");
    }
    return { host, port, user, pass, from };
}

async function openSmtpFor(org: any): Promise<void> {
    await closeSmtpClient();
    currentDebugRedirect = (org?.debug_redirect_email as string) || null;
    const cfg = resolveSmtpConfig(org);
    smtpClient = new SMTPClient({
        connection: {
            hostname: cfg.host,
            port:     cfg.port,
            tls:      false,        // STARTTLS auto-negotiated on 2525/587
            auth:     { username: cfg.user, password: cfg.pass },
        },
        // Log every SMTP command + response so we can see what the server
        // actually said when denomailer throws its generic "invalid cmd".
        // Verbose, but the Supabase function logs are the only window we
        // have into the SMTP conversation.
        debug: {
            log:           true,
            allowUnsecure: true,
            encodeLB:      false,
            noStartTLS:    false,
        },
    });
    smtpFrom = cfg.from;
}

async function closeSmtpClient(): Promise<void> {
    if (!smtpClient) return;
    try { await smtpClient.close(); } catch { /* swallow on shutdown */ }
    smtpClient = null;
}

// Hand-rolled SMTP send used by the test-send path. We bypass denomailer
// entirely because denomailer's error wrapping reduces every server
// rejection to a generic "invalid cmd" string with no visibility into
// which command failed or what the server actually said.
//
// Returns a transcript of the entire conversation. On failure throws an
// Error with the full transcript in .message so the caller can surface
// the precise SMTP server reply (e.g. "535 5.7.0 Auth failed") instead
// of a useless cryptic error.
async function rawSmtpSend(
    cfg: SmtpConfig,
    to: string,
    subject: string,
    html: string,
    redirectOverride: string | null = null,
): Promise<string> {
    // Apply per-org / explicit redirect so the test-send and preview
    // paths honour the same routing rules the cron does.
    const effectiveRedirect = redirectOverride ?? currentDebugRedirect ?? DEBUG_REDIRECT_EMAIL ?? null;
    if (effectiveRedirect) {
        subject = `[DEBUG -> ${to}] ${subject}`;
        html = `<div style="background:#fef08a;padding:12px;` +
            `font-family:sans-serif;border-bottom:2px solid #ca8a04">` +
            `<b>[DEBUG]</b> redirected from <b>${to}</b>.</div>` + html;
        to = effectiveRedirect;
    }
    const lines: string[] = [];
    const log = (line: string) => { lines.push(line); console.log("[smtp]", line); };

    const conn = await Deno.connect({ hostname: cfg.host, port: cfg.port });
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let tlsConn: Deno.TlsConn | null = null;

    const currentConn = (): Deno.Conn => tlsConn ?? conn;

    const read = async (): Promise<string> => {
        const buf = new Uint8Array(8192);
        const n = await currentConn().read(buf);
        if (n === null) throw new Error("connection closed unexpectedly\n" + lines.join("\n"));
        const text = decoder.decode(buf.subarray(0, n));
        for (const ln of text.split(/\r?\n/)) if (ln) log("< " + ln);
        return text;
    };
    const write = async (s: string, redact = false): Promise<void> => {
        log("> " + (redact ? "<redacted>" : s.replace(/\r?\n$/, "")));
        await currentConn().write(encoder.encode(s));
    };
    const expect = async (prefix: string): Promise<string> => {
        const resp = await read();
        // SMTP multi-line responses use "250-" for continuation, "250 " for last.
        // Match against the FINAL response code line.
        const finalLine = resp.split(/\r?\n/).reverse().find((ln) => /^\d{3} /.test(ln))
            ?? resp.split(/\r?\n/).reverse().find((ln) => /^\d{3}-/.test(ln))
            ?? resp;
        if (!finalLine.startsWith(prefix)) {
            throw new Error(`expected ${prefix}, got: ${finalLine.trim()}\n--- full transcript ---\n` + lines.join("\n"));
        }
        return resp;
    };

    try {
        await expect("220");                                  // greeting
        await write(`EHLO ${cfg.host}\r\n`);
        const ehloResp = await expect("250");

        // Upgrade to TLS via STARTTLS if the server advertises it (plaintext
        // port 2525 / 587 case). Skip if already on implicit-TLS port 465.
        if (cfg.port !== 465 && /STARTTLS/i.test(ehloResp)) {
            await write("STARTTLS\r\n");
            await expect("220");
            tlsConn = await Deno.startTls(conn, { hostname: cfg.host });
            await write(`EHLO ${cfg.host}\r\n`);
            await expect("250");
        }

        // AUTH LOGIN: username and password are base64-encoded one per write.
        await write("AUTH LOGIN\r\n");
        await expect("334");
        await write(btoa(cfg.user) + "\r\n", true);
        await expect("334");
        await write(btoa(cfg.pass) + "\r\n", true);
        await expect("235");                                  // auth ok

        // Parse "Name <email>" or bare "email" — only the email part goes
        // in MAIL FROM:.
        const fromAddr = (cfg.from.match(/<([^>]+)>/)?.[1] ?? cfg.from).trim();
        await write(`MAIL FROM:<${fromAddr}>\r\n`);
        await expect("250");
        await write(`RCPT TO:<${to}>\r\n`);
        await expect("250");
        await write("DATA\r\n");
        await expect("354");

        const dateHeader = new Date().toUTCString();
        const messageId = `<${crypto.randomUUID()}@${cfg.host}>`;
        const body =
            `From: ${cfg.from}\r\n` +
            `To: ${to}\r\n` +
            `Subject: ${subject}\r\n` +
            `Date: ${dateHeader}\r\n` +
            `Message-ID: ${messageId}\r\n` +
            `MIME-Version: 1.0\r\n` +
            `Content-Type: text/html; charset=utf-8\r\n` +
            `\r\n` +
            html.replace(/^\./gm, "..") +     // dot-stuff per RFC 5321 §4.5.2
            `\r\n.\r\n`;
        await write(body);
        await expect("250");                                  // accepted

        await write("QUIT\r\n");
        try { await read(); } catch { /* server may close before reply */ }
        return lines.join("\n");
    } finally {
        try { tlsConn?.close(); } catch { /* */ }
        try { conn.close(); } catch { /* */ }
    }
}

async function sendEmail(to: string, subject: string, html: string): Promise<void> {
    if (!smtpClient) throw new Error("SMTP client not initialised — call openSmtpFor(org) first");
    let actualTo      = to;
    let actualSubject = subject;
    let actualHtml    = html;
    // Per-org debug redirect wins over the global env var. Either one
    // pulls every send into a single inbox so admins can verify the
    // automation without spamming staff.
    const redirect = currentDebugRedirect ?? DEBUG_REDIRECT_EMAIL;
    if (redirect) {
        actualTo      = redirect;
        actualSubject = `[DEBUG -> ${to}] ${subject}`;
        actualHtml    = `<div style="background:#fef08a;padding:12px;` +
            `font-family:sans-serif;border-bottom:2px solid #ca8a04">` +
            `<b>[DEBUG]</b> redirected from <b>${to}</b>. Clear the debug ` +
            `redirect (Configure &rarr; SMTP) to send for real.</div>` + html;
    }
    await smtpClient.send({
        from:    smtpFrom,
        to:      actualTo,
        subject: actualSubject,
        content: "auto",
        html:    actualHtml,
    });
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

async function getOrgTimezone(orgId: number): Promise<string> {
    // Timezone lives on app_settings (Attendium's table). We have service
    // role so RLS doesn't block us. Fall back to UTC if not set.
    const { data } = await supabase.from("app_settings")
        .select("timezone").eq("organisation_id", orgId).maybeSingle();
    return (data?.timezone as string) || "UTC";
}

async function getOrgName(orgId: number): Promise<string> {
    const { data } = await supabase.from("organisations")
        .select("name").eq("id", orgId).maybeSingle();
    return (data?.name as string) || "your organisation";
}

async function getAdminEmails(orgId: number): Promise<string[]> {
    const { data: admins } = await supabase
        .from("admins").select("user_id, role, organisation_id")
        .or(`organisation_id.eq.${orgId},organisation_id.is.null`);
    const emails: string[] = [];
    for (const a of admins || []) {
        try {
            const { data: u } = await supabase.auth.admin.getUserById(a.user_id);
            if (u?.user?.email) emails.push(u.user.email);
        } catch (err) {
            console.error(`getAdminEmails: lookup failed for ${a.user_id}`, err);
        }
    }
    return [...new Set(emails)];
}

// Active employees in an org with no submitted timesheet for `weekStart`.
// Truly-overhead employees (admin/ops in an overhead department, no rate)
// are excluded — they don't file timesheets so reminders / overdue mails
// would just spam them. Employees whose department is INACTIVE are also
// excluded — admins use the inactive flag to "archive" a department and
// expect notifications to stop.
async function getUnsubmittedEmployees(orgId: number, weekStart: string)
        : Promise<Array<{ id: number; name: string; email: string }>> {
    const [empRes, deptRes] = await Promise.all([
        supabase.from("users")
            .select("id, name, email, department_id, cost_rate, sell_rate, rate_source_department_id")
            .eq("organisation_id", orgId)
            .eq("active", true)
            .not("email", "is", null),
        supabase.from("departments")
            .select("id, is_overhead, active")
            .eq("organisation_id", orgId),
    ]);
    const employees = empRes.data || [];
    const deptOverhead = new Map<number, boolean>();
    const deptActive = new Map<number, boolean>();
    for (const d of (deptRes.data || []) as any[]) {
        deptOverhead.set(d.id as number, !!d.is_overhead);
        deptActive.set(d.id as number, !!d.active);
    }
    if (!employees.length) return [];

    const billing = employees.filter((e: any) => {
        // Skip employees in inactive (archived) departments.
        if (e.department_id && deptActive.get(e.department_id) === false) return false;
        if (!deptOverhead.get(e.department_id)) return true;
        if (e.rate_source_department_id != null) return true;
        if (e.cost_rate != null) return true;
        if (e.sell_rate != null) return true;
        return false;
    });
    if (!billing.length) return [];

    const userIds = billing.map((e: any) => e.id);
    const { data: tsRows } = await supabase
        .from("timesheets")
        .select("user_id, status")
        .eq("organisation_id", orgId)
        .eq("week_start", weekStart)
        .in("user_id", userIds);

    const submittedUserIds = new Set(
        (tsRows || [])
            .filter((t: any) => t.status === "submitted" || t.status === "approved")
            .map((t: any) => t.user_id)
    );
    return billing
        .filter((e: any) => !submittedUserIds.has(e.id) && e.email)
        .map((e: any) => ({ id: e.id, name: e.name || "", email: e.email }));
}

// ---------------------------------------------------------------------------
// Email body templates
// ---------------------------------------------------------------------------

function reminderHtml(orgName: string, weekStart: string, weekEnd: string,
                     deadlineLine: string): string {
    return `
        <div style="font-family:sans-serif;color:#0f172a">
            <p>Hi,</p>
            <p>This is a reminder that your timesheet for the week of
            <b>${escapeHtml(formatDate(weekStart))}</b> to
            <b>${escapeHtml(formatDate(weekEnd))}</b> at
            <b>${escapeHtml(orgName)}</b> hasn't been submitted yet.</p>
            <p>${escapeHtml(deadlineLine)}</p>
            <p><a href="${APP_BASE_URL}/timesheet.html"
                  style="display:inline-block;padding:10px 16px;background:#0f172a;color:#fff;text-decoration:none;border-radius:6px">
                Open my timesheet
            </a></p>
            <p style="color:#64748b;font-size:13px;margin-top:24px">
                Sent automatically by PTL Timesheet. Disable these emails in
                Configure &rarr; Settings.
            </p>
        </div>
    `;
}

function overdueEmployeeHtml(orgName: string, weekStart: string, weekEnd: string): string {
    return `
        <div style="font-family:sans-serif;color:#0f172a">
            <p>Hi,</p>
            <p>Your timesheet for the week of
            <b>${escapeHtml(formatDate(weekStart))}</b> to
            <b>${escapeHtml(formatDate(weekEnd))}</b> at
            <b>${escapeHtml(orgName)}</b> is <b>overdue</b>.</p>
            <p>Please submit it as soon as possible.</p>
            <p><a href="${APP_BASE_URL}/timesheet.html"
                  style="display:inline-block;padding:10px 16px;background:#dc2626;color:#fff;text-decoration:none;border-radius:6px">
                Submit my timesheet
            </a></p>
            <p style="color:#64748b;font-size:13px;margin-top:24px">
                Sent automatically by PTL Timesheet. Disable these emails in
                Configure &rarr; Settings.
            </p>
        </div>
    `;
}

function overdueAdminHtml(orgName: string, weekStart: string, weekEnd: string,
                          unsubmitted: Array<{ name: string; email: string }>): string {
    if (unsubmitted.length === 0) {
        return `
            <div style="font-family:sans-serif;color:#0f172a">
                <p>Hi,</p>
                <p>Every employee submitted their timesheet for the week of
                <b>${escapeHtml(formatDate(weekStart))}</b> to
                <b>${escapeHtml(formatDate(weekEnd))}</b> at
                <b>${escapeHtml(orgName)}</b>. Nice work.</p>
            </div>
        `;
    }
    const rows = unsubmitted.map(e => `
        <tr>
            <td style="padding:8px;border-bottom:1px solid #e2e8f0">${escapeHtml(e.name)}</td>
            <td style="padding:8px;border-bottom:1px solid #e2e8f0">${escapeHtml(e.email)}</td>
        </tr>
    `).join("");
    return `
        <div style="font-family:sans-serif;color:#0f172a">
            <p>Hi,</p>
            <p>${unsubmitted.length} employee(s) at <b>${escapeHtml(orgName)}</b>
            still haven't submitted their timesheet for the week of
            <b>${escapeHtml(formatDate(weekStart))}</b> to
            <b>${escapeHtml(formatDate(weekEnd))}</b>:</p>
            <table style="border-collapse:collapse;font-size:14px">
                <thead><tr style="background:#f1f5f9">
                    <th style="padding:8px;text-align:left">Employee</th>
                    <th style="padding:8px;text-align:left">Email</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
            <p style="color:#64748b;font-size:13px;margin-top:24px">
                Sent automatically by PTL Timesheet. Disable in
                Configure &rarr; Settings.
            </p>
        </div>
    `;
}

function discrepancyHtml(orgName: string, weekStart: string, weekEnd: string,
                         tolerance: number,
                         rows: Array<{ name: string; loggedHours: number; clockedHours: number; diff: number }>) {
    if (rows.length === 0) {
        return `
            <div style="font-family:sans-serif;color:#0f172a">
                <p>Hi,</p>
                <p>No clock-vs-timesheet discrepancies above the
                ${tolerance}h tolerance for the week of
                <b>${escapeHtml(formatDate(weekStart))}</b> to
                <b>${escapeHtml(formatDate(weekEnd))}</b> at
                <b>${escapeHtml(orgName)}</b>.</p>
            </div>
        `;
    }
    const tableRows = rows.map(r => `
        <tr>
            <td style="padding:8px;border-bottom:1px solid #e2e8f0">${escapeHtml(r.name)}</td>
            <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right">${r.loggedHours.toFixed(2)}</td>
            <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right">${r.clockedHours.toFixed(2)}</td>
            <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:600;color:${r.diff > 0 ? "#dc2626" : "#0369a1"}">
                ${r.diff > 0 ? "+" : ""}${r.diff.toFixed(2)}
            </td>
        </tr>
    `).join("");
    return `
        <div style="font-family:sans-serif;color:#0f172a">
            <p>Hi,</p>
            <p>${rows.length} employee(s) at <b>${escapeHtml(orgName)}</b>
            had clock-vs-timesheet discrepancies greater than
            <b>${tolerance}h</b> for the week of
            <b>${escapeHtml(formatDate(weekStart))}</b> to
            <b>${escapeHtml(formatDate(weekEnd))}</b>:</p>
            <table style="border-collapse:collapse;font-size:14px">
                <thead><tr style="background:#f1f5f9">
                    <th style="padding:8px;text-align:left">Employee</th>
                    <th style="padding:8px;text-align:right">Logged (h)</th>
                    <th style="padding:8px;text-align:right">Clocked (h)</th>
                    <th style="padding:8px;text-align:right">Diff (logged - clocked)</th>
                </tr></thead>
                <tbody>${tableRows}</tbody>
            </table>
            <p style="color:#64748b;font-size:13px;margin-top:24px">
                Sent automatically by PTL Timesheet. Disable in
                Configure &rarr; Settings &rarr; Clock comparison.
            </p>
        </div>
    `;
}

// ---------------------------------------------------------------------------
// Notification handlers
// ---------------------------------------------------------------------------

async function fireReminder(org: any, slot: 1 | 2, weekStart: string, weekEnd: string,
                            tz: string, orgName: string): Promise<number> {
    const employees = await getUnsubmittedEmployees(org.id, weekStart);
    if (!employees.length) return 0;

    const dlDay  = (org.deadline_day  as string) || "monday";
    const dlTime = (org.deadline_time as string) || "08:00";
    const deadlineLine = `Deadline: ${dlDay} ${dlTime}` +
        (org.deadline_week === "this_week" ? " (this week)" : " (next week)") + ".";

    const subject = `PTL Timesheet — reminder, week ${formatDate(weekStart)}`;
    const html    = reminderHtml(orgName, weekStart, weekEnd, deadlineLine);
    let sent = 0;
    for (const e of employees) {
        try { await sendEmail(e.email, subject, html); sent++; }
        catch (err) { console.error(`reminder send failed (user ${e.id})`, err); }
    }
    const stampCol = slot === 1 ? "reminder_last_sent_at" : "reminder_2_last_sent_at";
    await supabase.from("organisations")
        .update({ [stampCol]: new Date().toISOString() }).eq("id", org.id);
    return sent;
}

async function fireOverdue(org: any, weekStart: string, weekEnd: string,
                           tz: string, orgName: string): Promise<number> {
    const recipientMode = (org.notify_overdue_recipient as string) || "employee";
    const employees = await getUnsubmittedEmployees(org.id, weekStart);

    let sent = 0;
    if (recipientMode === "employee" || recipientMode === "both") {
        const subject = `PTL Timesheet — OVERDUE, week ${formatDate(weekStart)}`;
        const html    = overdueEmployeeHtml(orgName, weekStart, weekEnd);
        for (const e of employees) {
            try { await sendEmail(e.email, subject, html); sent++; }
            catch (err) { console.error(`overdue (employee) send failed (user ${e.id})`, err); }
        }
    }
    if (recipientMode === "admins" || recipientMode === "both") {
        const subject = `PTL Timesheet — overdue digest, week ${formatDate(weekStart)}`;
        const html    = overdueAdminHtml(orgName, weekStart, weekEnd, employees);
        const admins  = await getAdminEmails(org.id);
        for (const addr of admins) {
            try { await sendEmail(addr, subject, html); sent++; }
            catch (err) { console.error(`overdue (admin) send failed (${addr})`, err); }
        }
    }
    await supabase.from("organisations")
        .update({ overdue_last_sent_at: new Date().toISOString() }).eq("id", org.id);
    return sent;
}

async function fireDiscrepancy(org: any, weekStart: string, weekEnd: string,
                               tz: string, orgName: string): Promise<number> {
    const tolerance = Number(org.clock_tolerance_hours ?? 0.5);

    // Logged hours per user from public.timesheet_entries (sum across days).
    const { data: tsRows } = await supabase.from("timesheets")
        .select("id, user_id")
        .eq("organisation_id", org.id)
        .eq("week_start", weekStart);
    const tsIdToUserId = new Map<number, number>();
    for (const t of tsRows || []) tsIdToUserId.set(t.id as number, t.user_id as number);

    const tsIds = (tsRows || []).map((t: any) => t.id);
    const loggedByUser = new Map<number, number>();
    if (tsIds.length) {
        const { data: entries } = await supabase.from("timesheet_entries")
            .select("timesheet_id, mon_hours, tue_hours, wed_hours, thu_hours, fri_hours, sat_hours, sun_hours")
            .in("timesheet_id", tsIds);
        for (const e of entries || []) {
            const uid = tsIdToUserId.get(e.timesheet_id as number);
            if (!uid) continue;
            const sum = (Number(e.mon_hours) || 0) + (Number(e.tue_hours) || 0) +
                        (Number(e.wed_hours) || 0) + (Number(e.thu_hours) || 0) +
                        (Number(e.fri_hours) || 0) + (Number(e.sat_hours) || 0) +
                        (Number(e.sun_hours) || 0);
            loggedByUser.set(uid, (loggedByUser.get(uid) || 0) + sum);
        }
    }

    // Clocked hours per user from Attendium's weekly_timesheet RPC.
    let clockRows: Array<{ user_id: number; hours: number }> = [];
    try {
        const { data, error } = await supabase.rpc("weekly_timesheet", {
            p_week_start: weekStart, p_tz: tz, p_org_id: org.id,
        });
        if (error) throw error;
        clockRows = (data || []) as any[];
    } catch (err) {
        console.error(`discrepancy: weekly_timesheet RPC failed (org ${org.id})`, err);
        return 0;
    }
    const clockedByUser = new Map<number, number>();
    for (const r of clockRows) {
        clockedByUser.set(r.user_id, (clockedByUser.get(r.user_id) || 0) + Number(r.hours || 0));
    }

    // Resolve names. Active employees only - we don't chase ex-staff discrepancies.
    const userIds = [...new Set([...loggedByUser.keys(), ...clockedByUser.keys()])];
    if (!userIds.length) return 0;
    const { data: users } = await supabase.from("users")
        .select("id, name, active").in("id", userIds);
    const nameById = new Map<number, string>();
    for (const u of users || []) {
        if (u.active) nameById.set(u.id as number, (u.name as string) || "");
    }

    const flagged: Array<{ name: string; loggedHours: number; clockedHours: number; diff: number }> = [];
    for (const uid of userIds) {
        const name = nameById.get(uid);
        if (!name) continue;  // skip inactive
        const logged  = loggedByUser.get(uid)  || 0;
        const clocked = clockedByUser.get(uid) || 0;
        const diff = logged - clocked;
        if (Math.abs(diff) > tolerance) {
            flagged.push({ name, loggedHours: logged, clockedHours: clocked, diff });
        }
    }
    flagged.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

    const subject = `PTL Timesheet — clock discrepancies, week ${formatDate(weekStart)}`;
    const html    = discrepancyHtml(orgName, weekStart, weekEnd, tolerance, flagged);
    const admins  = await getAdminEmails(org.id);
    let sent = 0;
    for (const addr of admins) {
        try { await sendEmail(addr, subject, html); sent++; }
        catch (err) { console.error(`discrepancy admin send failed (${addr})`, err); }
    }
    await supabase.from("organisations")
        .update({ discrepancy_last_sent_at: new Date().toISOString() }).eq("id", org.id);
    return sent;
}

// ---------------------------------------------------------------------------
// Manager-approval digest
// ---------------------------------------------------------------------------
//
// For each user with users.is_manager = true, find the departments they
// own (departments.manager_id = user.id) and roll up last week's
// timesheet status of every employee in those departments. Email the
// manager a digest split by department: submitted (awaiting their
// approval), not-submitted (missing entirely), already-approved
// (informational footnote). Skips managers whose departments have
// nothing pending and nothing missing.

interface ManagerDeptRollup {
    name:         string;
    submitted:    string[];   // names of employees whose timesheet needs approval
    notSubmitted: string[];   // names of employees who haven't submitted at all
    approvedCount: number;    // count only; informational
}

function managerApprovalHtml(
    mgrName: string,
    orgName: string,
    weekStart: string,
    weekEnd: string,
    depts: ManagerDeptRollup[],
): string {
    const sections = depts.map((d) => {
        const subHtml = d.submitted.length
            ? `<p style="margin:6px 0 4px"><b>Awaiting your approval (${d.submitted.length}):</b></p>` +
              `<ul style="margin:0 0 12px 18px">${d.submitted.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>`
            : "";
        const missHtml = d.notSubmitted.length
            ? `<p style="margin:6px 0 4px;color:#dc2626"><b>Not submitted (${d.notSubmitted.length}):</b></p>` +
              `<ul style="margin:0 0 12px 18px">${d.notSubmitted.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>`
            : "";
        const okHtml = d.approvedCount
            ? `<p style="margin:6px 0 16px;color:#64748b;font-size:13px">${d.approvedCount} already approved.</p>`
            : "";
        return `
            <div style="border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:12px">
                <h3 style="margin:0 0 8px;font-size:16px">${escapeHtml(d.name)}</h3>
                ${subHtml}${missHtml}${okHtml}
            </div>`;
    }).join("");
    return `
        <div style="font-family:sans-serif;color:#0f172a;max-width:600px">
            <p>Hi ${escapeHtml(mgrName)},</p>
            <p>Status of timesheets in your department(s) at <b>${escapeHtml(orgName)}</b>
            for the week of <b>${escapeHtml(formatDate(weekStart))}</b> to
            <b>${escapeHtml(formatDate(weekEnd))}</b>:</p>
            ${sections}
            <p><a href="${APP_BASE_URL}/department.html"
                  style="display:inline-block;padding:10px 16px;background:#0f172a;color:#fff;text-decoration:none;border-radius:6px">
                Open My Departments
            </a></p>
            <p style="color:#64748b;font-size:13px;margin-top:24px">
                Sent automatically by PTL Timesheet. Disable in
                Configure &rarr; Settings.
            </p>
        </div>`;
}

async function buildManagerRollup(
    orgId: number,
    mgr: { id: number; name: string; email: string },
    weekStart: string,
): Promise<ManagerDeptRollup[] | null> {
    const { data: depts } = await supabase.from("departments")
        .select("id, name, is_overhead")
        .eq("organisation_id", orgId)
        .eq("active", true)
        .eq("manager_id", mgr.id);
    if (!depts?.length) return null;

    const deptIds = depts.map((d: any) => d.id);
    // Pull rate columns so we can skip truly-overhead employees (admin /
    // ops staff sitting in an overhead dept with no specific rate) from
    // the "submitted vs not submitted" counts. Rate-having members in
    // an overhead dept stay in — they file real timesheets.
    const { data: emps } = await supabase.from("users")
        .select("id, name, department_id, cost_rate, sell_rate, rate_source_department_id")
        .eq("organisation_id", orgId)
        .eq("active", true)
        .in("department_id", deptIds);
    if (!emps?.length) return null;

    const deptById = new Map<number, any>();
    for (const d of depts) deptById.set(d.id as number, d);
    const billingEmps = emps.filter((e: any) => {
        const d = deptById.get(e.department_id);
        if (!d?.is_overhead) return true;
        if (e.rate_source_department_id != null) return true;
        if (e.cost_rate != null) return true;
        if (e.sell_rate != null) return true;
        return false;
    });
    if (!billingEmps.length) return null;

    const empIds = billingEmps.map((e: any) => e.id);
    const { data: tsRows } = await supabase.from("timesheets")
        .select("user_id, status")
        .eq("organisation_id", orgId)
        .eq("week_start", weekStart)
        .in("user_id", empIds);
    const tsByUser = new Map<number, string>();
    for (const t of tsRows || []) tsByUser.set(t.user_id as number, (t.status as string) || "draft");

    const byDept = new Map<number, ManagerDeptRollup>();
    // Only create buckets for departments that still have billing
    // members — otherwise an empty Management dept would render with
    // zero rows, which is just noise.
    const survivingDeptIds = new Set(billingEmps.map((e: any) => e.department_id));
    for (const d of depts) {
        if (!survivingDeptIds.has(d.id as number)) continue;
        byDept.set(d.id as number,
            { name: d.name as string, submitted: [], notSubmitted: [], approvedCount: 0 });
    }
    for (const e of billingEmps) {
        const bucket = byDept.get(e.department_id as number);
        if (!bucket) continue;
        const status = tsByUser.get(e.id as number);
        if (status === "submitted")        bucket.submitted.push(e.name || `Employee ${e.id}`);
        else if (status === "approved")    bucket.approvedCount++;
        else                                bucket.notSubmitted.push(e.name || `Employee ${e.id}`);
    }
    return [...byDept.values()];
}

async function fireManagerApproval(org: any, weekStart: string, weekEnd: string,
                                   _tz: string, orgName: string): Promise<number> {
    const { data: managers } = await supabase.from("users")
        .select("id, name, email")
        .eq("organisation_id", org.id)
        .eq("active", true)
        .eq("is_manager", true)
        .not("email", "is", null);
    if (!managers?.length) return 0;

    let sent = 0;
    for (const mgr of managers as any[]) {
        const rollup = await buildManagerRollup(org.id, mgr, weekStart);
        if (!rollup) continue;
        // Skip if nothing actionable in any of their departments.
        const anyPending = rollup.some((d) => d.submitted.length > 0 || d.notSubmitted.length > 0);
        if (!anyPending) continue;
        const subject = `PTL Timesheet — Timesheets to approve, week ${formatDate(weekStart)}`;
        const html    = managerApprovalHtml(mgr.name || "there", orgName, weekStart, weekEnd, rollup);
        try { await sendEmail(mgr.email, subject, html); sent++; }
        catch (err) { console.error(`manager_approval send failed (mgr ${mgr.id})`, err); }
    }
    await supabase.from("organisations")
        .update({ manager_approval_last_sent_at: new Date().toISOString() })
        .eq("id", org.id);
    return sent;
}

// ---------------------------------------------------------------------------
// Per-org dispatch
// ---------------------------------------------------------------------------

async function processOrg(org: any, force: { kind?: string } = {}): Promise<any> {
    const tz      = await getOrgTimezone(org.id);
    const orgName = await getOrgName(org.id);
    const now     = new Date();
    const today   = localDate(tz, now);

    // Reminder is for the CURRENT week; overdue + discrepancy are for the
    // PREVIOUS week (the one whose deadline just passed).
    const thisMonday    = mondayOf(tz, now);
    const lastMonday    = addDaysIso(thisMonday, -7);
    const thisSunday    = addDaysIso(thisMonday,  6);
    const lastSunday    = addDaysIso(lastMonday,  6);

    // Decide which slots fire *before* touching SMTP, so quiet cron ticks
    // (no slot matches) never open a connection — keeps the logs clean
    // when SMTP isn't configured yet.
    const fireR1 = force.kind === "reminder" ||
        (org.notify_reminder &&
         slotMatches(tz, org.reminder_day,   org.reminder_time,   now) &&
         !alreadySentToday(tz, org.reminder_last_sent_at, now));
    const fireR2 = force.kind === "reminder_2" ||
        (org.notify_reminder &&
         slotMatches(tz, org.reminder_day_2, org.reminder_time_2, now) &&
         !alreadySentToday(tz, org.reminder_2_last_sent_at, now));
    const fireO = force.kind === "overdue" ||
        (org.notify_overdue &&
         slotMatches(tz, org.overdue_day, org.overdue_time, now) &&
         !alreadySentToday(tz, org.overdue_last_sent_at, now));
    const fireD = force.kind === "discrepancy" ||
        (org.notify_discrepancy &&
         slotMatches(tz, org.discrepancy_day, org.discrepancy_time, now) &&
         !alreadySentToday(tz, org.discrepancy_last_sent_at, now));
    const fireMA = force.kind === "manager_approval" ||
        (org.notify_manager_approval &&
         slotMatches(tz, org.manager_approval_day, org.manager_approval_time, now) &&
         !alreadySentToday(tz, org.manager_approval_last_sent_at, now));

    if (!fireR1 && !fireR2 && !fireO && !fireD && !fireMA) {
        return { skipped: today };
    }

    // At least one slot fires → open SMTP now.
    await openSmtpFor(org);

    const result: Record<string, any> = {};

    if (fireR1) {
        try {
            const sent = await fireReminder(org, 1, thisMonday, thisSunday, tz, orgName);
            result.reminder = { sent };
        } catch (err) {
            console.error(`reminder failed (org ${org.id})`, err);
            result.reminder = { error: String(err) };
        }
    }

    if (fireR2) {
        try {
            const sent = await fireReminder(org, 2, thisMonday, thisSunday, tz, orgName);
            result.reminder_2 = { sent };
        } catch (err) {
            console.error(`reminder_2 failed (org ${org.id})`, err);
            result.reminder_2 = { error: String(err) };
        }
    }

    if (fireO) {
        try {
            const sent = await fireOverdue(org, lastMonday, lastSunday, tz, orgName);
            result.overdue = { sent };
        } catch (err) {
            console.error(`overdue failed (org ${org.id})`, err);
            result.overdue = { error: String(err) };
        }
    }

    if (fireD) {
        try {
            const sent = await fireDiscrepancy(org, lastMonday, lastSunday, tz, orgName);
            result.discrepancy = { sent };
        } catch (err) {
            console.error(`discrepancy failed (org ${org.id})`, err);
            result.discrepancy = { error: String(err) };
        }
    }

    if (fireMA) {
        try {
            // Manager-approval looks at LAST week (the cycle just ended).
            const sent = await fireManagerApproval(org, lastMonday, lastSunday, tz, orgName);
            result.manager_approval = { sent };
        } catch (err) {
            console.error(`manager_approval failed (org ${org.id})`, err);
            result.manager_approval = { error: String(err) };
        }
    }

    return result;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// CORS headers attached to every response so browser-initiated invocations
// (Configure → "Send test email") pass the preflight check. Cron pings the
// function server-to-server so they're harmless for that path too.
const CORS_HEADERS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function withCors(init: ResponseInit = {}): ResponseInit {
    return {
        ...init,
        headers: { ...(init.headers || {}), ...CORS_HEADERS },
    };
}

Deno.serve(async (req) => {
    // Browsers send an OPTIONS preflight before the actual POST.
    // 204 forbids a body, so pass null.
    if (req.method === "OPTIONS") {
        return new Response(null, withCors({ status: 204 }));
    }

    let force_org_id:    number | null = null;
    let force_kind:      string | null = null;
    let test_send_to:    string | null = null;
    let test_kind:       string | null = null;
    let test_redirect_to:string | null = null;
    if (req.method === "POST") {
        try {
            const body = await req.json();
            if (body?.force_org_id)    force_org_id    = Number(body.force_org_id);
            if (body?.force_kind)      force_kind      = String(body.force_kind);
            if (body?.test_send_to)    test_send_to    = String(body.test_send_to);
            if (body?.test_kind)       test_kind       = String(body.test_kind);
            if (body?.test_redirect_to) test_redirect_to = String(body.test_redirect_to);
        } catch { /* empty body is fine */ }
    }

    // Test-notification preview mode: builds the requested notification
    // type's email body (using the same templates the scheduled cron
    // uses) and routes a single copy to test_redirect_to. No DB writes,
    // no last_sent_at touched, no fan-out to real recipients. Lets the
    // admin see exactly what each kind of email looks like before
    // turning the live toggles on.
    if (test_kind && test_redirect_to && force_org_id) {
        const { data: org, error: orgErr } = await supabase.from("organisations")
            .select("id, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, " +
                    "deadline_day, deadline_time, deadline_week, clock_tolerance_hours, " +
                    "notify_overdue_recipient, debug_redirect_email")
            .eq("id", force_org_id).maybeSingle();
        if (orgErr || !org) {
            return new Response(JSON.stringify({ ok: false, error: "Org not found" }),
                withCors({ status: 404, headers: { "content-type": "application/json" } }));
        }

        let cfg: SmtpConfig;
        try { cfg = resolveSmtpConfig(org); }
        catch (err) {
            return new Response(JSON.stringify({ ok: false, error: String((err as Error).message ?? err) }),
                withCors({ status: 500, headers: { "content-type": "application/json" } }));
        }

        const tz       = await getOrgTimezone(org.id);
        const orgName  = await getOrgName(org.id);
        const now      = new Date();
        const thisMon  = mondayOf(tz, now);
        const lastMon  = addDaysIso(thisMon, -7);
        const thisSun  = addDaysIso(thisMon,  6);
        const lastSun  = addDaysIso(lastMon,  6);

        // Realistic placeholder data so digest/discrepancy templates have
        // visible content. The admin viewing the test understands these
        // aren't live names — they're labelled "Sample employee".
        const sampleUnsub = [
            { name: "Sample employee A", email: "samplea@example.com" },
            { name: "Sample employee B", email: "sampleb@example.com" },
        ];
        const sampleDiffs = [
            { name: "Sample employee A", loggedHours: 40,   clockedHours: 38.5, diff:  1.5 },
            { name: "Sample employee B", loggedHours: 37.5, clockedHours: 39,   diff: -1.5 },
        ];

        let subject: string;
        let html: string;
        switch (test_kind) {
            case "reminder": {
                const dlDay  = org.deadline_day  || "monday";
                const dlTime = org.deadline_time || "08:00";
                const deadlineLine = `Deadline: ${dlDay} ${dlTime}` +
                    (org.deadline_week === "this_week" ? " (this week)" : " (next week)") + ".";
                subject = `[TEST] PTL Timesheet — reminder, week ${formatDate(thisMon)}`;
                html    = reminderHtml(orgName, thisMon, thisSun, deadlineLine);
                break;
            }
            case "overdue_employee": {
                subject = `[TEST] PTL Timesheet — OVERDUE, week ${formatDate(lastMon)}`;
                html    = overdueEmployeeHtml(orgName, lastMon, lastSun);
                break;
            }
            case "overdue_admin": {
                subject = `[TEST] PTL Timesheet — overdue digest, week ${formatDate(lastMon)}`;
                html    = overdueAdminHtml(orgName, lastMon, lastSun, sampleUnsub);
                break;
            }
            case "discrepancy": {
                const tol = Number(org.clock_tolerance_hours ?? 0.5);
                subject = `[TEST] PTL Timesheet — clock discrepancies, week ${formatDate(lastMon)}`;
                html    = discrepancyHtml(orgName, lastMon, lastSun, tol, sampleDiffs);
                break;
            }
            case "manager_approval": {
                const sampleDepts: ManagerDeptRollup[] = [
                    {
                        name: "Sample Department A",
                        submitted: ["Sample employee A", "Sample employee B"],
                        notSubmitted: ["Sample employee C"],
                        approvedCount: 2,
                    },
                    {
                        name: "Sample Department B",
                        submitted: ["Sample employee D"],
                        notSubmitted: [],
                        approvedCount: 1,
                    },
                ];
                subject = `[TEST] PTL Timesheet — Timesheets to approve, week ${formatDate(lastMon)}`;
                html    = managerApprovalHtml("there", orgName, lastMon, lastSun, sampleDepts);
                break;
            }
            default:
                return new Response(JSON.stringify({ ok: false, error: `Unknown test_kind: ${test_kind}` }),
                    withCors({ status: 400, headers: { "content-type": "application/json" } }));
        }

        try {
            await rawSmtpSend(cfg, test_redirect_to, subject, html);
            return new Response(JSON.stringify({ ok: true, sent_to: test_redirect_to, test_kind }),
                withCors({ headers: { "content-type": "application/json" } }));
        } catch (err) {
            return new Response(JSON.stringify({ ok: false, error: String((err as Error).message ?? err) }),
                withCors({ status: 500, headers: { "content-type": "application/json" } }));
        }
    }

    // Test-send mode: open SMTP for the requested org, fire one canary
    // message to the supplied address, return success/failure. Used by
    // the Configure page's "Send test" button so admins can verify SMTP
    // creds without waiting for the scheduled cron tick.
    if (test_send_to) {
        if (!force_org_id) {
            return new Response(JSON.stringify({ error: "test_send_to requires force_org_id" }),
                withCors({ status: 400, headers: { "content-type": "application/json" } }));
        }
        const { data: org, error: orgErr } = await supabase.from("organisations")
            .select("id, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, debug_redirect_email")
            .eq("id", force_org_id).maybeSingle();
        if (orgErr || !org) {
            return new Response(JSON.stringify({ error: "Org not found" }),
                withCors({ status: 404, headers: { "content-type": "application/json" } }));
        }
        // Test-send goes through rawSmtpSend (not denomailer) so any
        // server-side rejection is surfaced verbatim with full transcript.
        let cfg: SmtpConfig;
        try {
            cfg = resolveSmtpConfig(org);
        } catch (err) {
            return new Response(JSON.stringify({ ok: false, error: String((err as Error).message ?? err) }),
                withCors({ status: 500, headers: { "content-type": "application/json" } }));
        }
        try {
            const transcript = await rawSmtpSend(
                cfg,
                test_send_to,
                "PTL Timesheet — SMTP test",
                `<p>This is a test email from the PTL Timesheet app. ` +
                `If you're reading it, the SMTP relay configured for org ${org.id} is working.</p>` +
                `<p style="color:#666;font-size:12px">Sent at ${new Date().toISOString()}</p>`,
            );
            return new Response(JSON.stringify({ ok: true, sent_to: test_send_to, transcript }),
                withCors({ headers: { "content-type": "application/json" } }));
        } catch (err) {
            return new Response(JSON.stringify({ ok: false, error: String((err as Error).message ?? err) }),
                withCors({ status: 500, headers: { "content-type": "application/json" } }));
        }
    }

    let q = supabase.from("organisations").select(`
        id,
        notify_reminder, reminder_day, reminder_time, reminder_last_sent_at,
        reminder_day_2, reminder_time_2, reminder_2_last_sent_at,
        notify_overdue, overdue_day, overdue_time, notify_overdue_recipient,
        overdue_last_sent_at,
        notify_discrepancy, discrepancy_day, discrepancy_time, discrepancy_last_sent_at,
        notify_manager_approval, manager_approval_day, manager_approval_time, manager_approval_last_sent_at,
        clock_tolerance_hours,
        deadline_week, deadline_day, deadline_time,
        smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from,
        debug_redirect_email
    `);
    if (force_org_id) q = q.eq("id", force_org_id);

    const { data: orgs, error } = await q;
    if (error) return new Response(error.message, withCors({ status: 500 }));

    const results: Record<string, any> = {};
    try {
        for (const org of orgs || []) {
            try {
                results[(org as any).id] = await processOrg(
                    org, force_org_id ? { kind: force_kind ?? undefined } : {});
            } catch (err) {
                console.error(`org ${(org as any).id} failed`, err);
                results[(org as any).id] = { error: String(err) };
            }
        }
    } finally {
        // Must close the SMTP connection or the Deno process stays alive
        // and the function times out instead of returning.
        await closeSmtpClient();
    }

    return new Response(JSON.stringify(results, null, 2),
        withCors({ headers: { "content-type": "application/json" } }));
});
