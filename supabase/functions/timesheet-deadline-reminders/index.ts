// Supabase Edge Function: timesheet-deadline-reminders
//
// Runs on a schedule before the Monday 8am deadline. For every active user
// who has no submission (or only a draft/rejected) for last week, enqueue a
// 'timesheet_reminder' notification and a 'manager_missing_submissions' digest
// for each manager.
//
// The existing `send-notifications` function (from the clock-app repo) drains
// pending_notifications and delivers them via Resend — we just enqueue here.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

function mondayOf(d: Date): Date {
  const date = new Date(d);
  const dow = date.getDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  date.setDate(date.getDate() + offset);
  date.setHours(0, 0, 0, 0);
  return date;
}
function isoDate(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

Deno.serve(async () => {
  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // "Last week" = the week whose Monday is 7 days before today's Monday.
    const today = new Date();
    const thisMonday = mondayOf(today);
    const lastMonday = new Date(thisMonday);
    lastMonday.setDate(lastMonday.getDate() - 7);
    const weekStart = isoDate(lastMonday);

    // 1. Find employees missing a submission for last week.
    const { data: missing, error } = await sb.rpc("missing_submissions", {
      p_week_start: weekStart,
    });
    if (error) throw error;

    // 2. Enqueue a per-employee reminder.
    if (missing && missing.length > 0) {
      await sb.from("pending_notifications").insert(
        missing.map((u: { user_id: number }) => ({
          user_id: u.user_id,
          kind: "timesheet_reminder",
          payload: { week_start: weekStart },
        }))
      );

      // 3. Group by manager and enqueue a digest for each manager.
      const byManager = new Map<number, typeof missing>();
      for (const u of missing) {
        if (!u.manager_id) continue;
        if (!byManager.has(u.manager_id)) byManager.set(u.manager_id, []);
        byManager.get(u.manager_id)!.push(u);
      }
      const digests = Array.from(byManager.entries()).map(([managerId, team]) => ({
        user_id: managerId,
        kind: "manager_missing_digest",
        payload: {
          week_start: weekStart,
          count: team.length,
          missing: team.map((t) => ({ id: t.user_id, name: t.name })),
        },
      }));
      if (digests.length > 0) await sb.from("pending_notifications").insert(digests);
    }

    return new Response(
      JSON.stringify({ ok: true, week_start: weekStart, missing_count: missing?.length || 0 }),
      { headers: { "content-type": "application/json" } }
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});
