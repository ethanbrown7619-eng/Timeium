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

const SMTP_HOST    = Deno.env.get("SMTP_HOST");
const SMTP_PORT    = Number(Deno.env.get("SMTP_PORT") ?? "2525");
const SMTP_USER    = Deno.env.get("SMTP_USER");
const SMTP_PASS    = Deno.env.get("SMTP_PASS");
const NOTIFY_FROM  = Deno.env.get("NOTIFY_FROM") ?? "PTL Time Sheet <clockapp@ptlmachinery.com>";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_BASE_URL = Deno.env.get("APP_BASE_URL") ?? "https://ptl-timesheet.workers.dev";

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

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

let smtpClient: SMTPClient | null = null;

function getSmtpClient(): SMTPClient {
    if (smtpClient) return smtpClient;
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
        throw new Error("SMTP_HOST / SMTP_USER / SMTP_PASS not set");
    }
    smtpClient = new SMTPClient({
        connection: {
            hostname: SMTP_HOST,
            port:     SMTP_PORT,
            tls:      false,        // STARTTLS auto-negotiated on 2525/587
            auth:     { username: SMTP_USER, password: SMTP_PASS },
        },
    });
    return smtpClient;
}

async function closeSmtpClient(): Promise<void> {
    if (!smtpClient) return;
    try { await smtpClient.close(); } catch { /* swallow on shutdown */ }
    smtpClient = null;
}

async function sendEmail(to: string, subject: string, html: string): Promise<void> {
    const client = getSmtpClient();
    await client.send({
        from:    NOTIFY_FROM,
        to,
        subject,
        content: "auto",
        html,
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
async function getUnsubmittedEmployees(orgId: number, weekStart: string)
        : Promise<Array<{ id: number; name: string; email: string }>> {
    const { data: employees } = await supabase
        .from("users")
        .select("id, name, email")
        .eq("organisation_id", orgId)
        .eq("active", true)
        .not("email", "is", null);
    if (!employees?.length) return [];

    const userIds = employees.map((e: any) => e.id);
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
    return employees
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

    const result: Record<string, any> = {};

    // Reminder slot 1
    const fireR1 = force.kind === "reminder" ||
        (org.notify_reminder &&
         slotMatches(tz, org.reminder_day,   org.reminder_time,   now) &&
         !alreadySentToday(tz, org.reminder_last_sent_at, now));
    if (fireR1) {
        try {
            const sent = await fireReminder(org, 1, thisMonday, thisSunday, tz, orgName);
            result.reminder = { sent };
        } catch (err) {
            console.error(`reminder failed (org ${org.id})`, err);
            result.reminder = { error: String(err) };
        }
    }

    // Reminder slot 2
    const fireR2 = force.kind === "reminder_2" ||
        (org.notify_reminder &&
         slotMatches(tz, org.reminder_day_2, org.reminder_time_2, now) &&
         !alreadySentToday(tz, org.reminder_2_last_sent_at, now));
    if (fireR2) {
        try {
            const sent = await fireReminder(org, 2, thisMonday, thisSunday, tz, orgName);
            result.reminder_2 = { sent };
        } catch (err) {
            console.error(`reminder_2 failed (org ${org.id})`, err);
            result.reminder_2 = { error: String(err) };
        }
    }

    // Overdue
    const fireO = force.kind === "overdue" ||
        (org.notify_overdue &&
         slotMatches(tz, org.overdue_day, org.overdue_time, now) &&
         !alreadySentToday(tz, org.overdue_last_sent_at, now));
    if (fireO) {
        try {
            const sent = await fireOverdue(org, lastMonday, lastSunday, tz, orgName);
            result.overdue = { sent };
        } catch (err) {
            console.error(`overdue failed (org ${org.id})`, err);
            result.overdue = { error: String(err) };
        }
    }

    // Discrepancy
    const fireD = force.kind === "discrepancy" ||
        (org.notify_discrepancy &&
         slotMatches(tz, org.discrepancy_day, org.discrepancy_time, now) &&
         !alreadySentToday(tz, org.discrepancy_last_sent_at, now));
    if (fireD) {
        try {
            const sent = await fireDiscrepancy(org, lastMonday, lastSunday, tz, orgName);
            result.discrepancy = { sent };
        } catch (err) {
            console.error(`discrepancy failed (org ${org.id})`, err);
            result.discrepancy = { error: String(err) };
        }
    }

    if (!Object.keys(result).length) result.skipped = today;
    return result;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
    let force_org_id: number | null = null;
    let force_kind:   string | null = null;
    if (req.method === "POST") {
        try {
            const body = await req.json();
            if (body?.force_org_id) force_org_id = Number(body.force_org_id);
            if (body?.force_kind)   force_kind   = String(body.force_kind);
        } catch { /* empty body is fine */ }
    }

    let q = supabase.from("organisations").select(`
        id,
        notify_reminder, reminder_day, reminder_time, reminder_last_sent_at,
        reminder_day_2, reminder_time_2, reminder_2_last_sent_at,
        notify_overdue, overdue_day, overdue_time, notify_overdue_recipient,
        overdue_last_sent_at,
        notify_discrepancy, discrepancy_day, discrepancy_time, discrepancy_last_sent_at,
        clock_tolerance_hours,
        deadline_week, deadline_day, deadline_time
    `);
    if (force_org_id) q = q.eq("id", force_org_id);

    const { data: orgs, error } = await q;
    if (error) return new Response(error.message, { status: 500 });

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
        { headers: { "content-type": "application/json" } });
});
