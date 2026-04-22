// PTL Timesheet — archive page (list of past timesheets).

import { getSupabase } from "/js/supabase-client.js";
import { notice, renderTopbar } from "/js/shared.js";

const sb = await getSupabase();

const { data: { session } } = await sb.auth.getSession();
if (!session) { location.replace("/signin.html"); throw new Error("not signed in"); }

let employee = null;
let isDeveloper = false;
let adminRow = null;
try { const r = await sb.rpc("is_developer"); isDeveloper = !!r.data; } catch {}
try {
  const r = await sb.from("admins").select("organisation_id, role").eq("user_id", session.user.id).maybeSingle();
  adminRow = r.data;
} catch {}
try {
  const r = await sb.from("users").select("id, organisation_id").eq("auth_user_id", session.user.id).maybeSingle();
  employee = r.data;
} catch {}

if (!employee) {
  location.replace("/welcome.html");
  throw new Error("no employee record");
}

renderTopbar({
  session,
  isDeveloper,
  adminRow,
  orgs: null,
  currentOrgId: employee.organisation_id,
  onOrgChange: () => {},
  active: "archive",
});

async function loadArchive() {
  const body = document.getElementById("archive-body");
  try {
    const { data: timesheets, error } = await sb
      .from("timesheets")
      .select("id, week_start, status, submitted_at")
      .eq("user_id", employee.id)
      .order("week_start", { ascending: false })
      .limit(52);
    if (error) throw error;

    if (!timesheets?.length) {
      body.innerHTML = `<tr><td colspan="5" class="muted small" style="text-align:center">No timesheets yet.</td></tr>`;
      return;
    }

    // Load entry totals for each timesheet
    const tsIds = timesheets.map((ts) => ts.id);
    const { data: allEntries } = await sb
      .from("timesheet_entries")
      .select("timesheet_id, mon_hours, tue_hours, wed_hours, thu_hours, fri_hours, sat_hours, sun_hours")
      .in("timesheet_id", tsIds);

    const totalsByTs = {};
    for (const e of allEntries || []) {
      const sum = (Number(e.mon_hours) || 0) + (Number(e.tue_hours) || 0) +
        (Number(e.wed_hours) || 0) + (Number(e.thu_hours) || 0) +
        (Number(e.fri_hours) || 0) + (Number(e.sat_hours) || 0) +
        (Number(e.sun_hours) || 0);
      totalsByTs[e.timesheet_id] = (totalsByTs[e.timesheet_id] || 0) + sum;
    }

    body.innerHTML = timesheets.map((ts) => {
      const ws = new Date(ts.week_start + "T00:00:00");
      const weekLabel = ws.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
      const total = totalsByTs[ts.id] || 0;
      const submitted = ts.submitted_at
        ? new Date(ts.submitted_at).toLocaleDateString()
        : "";

      return `
        <tr>
          <td><a href="/timesheet.html?week=${ts.week_start}">${weekLabel}</a></td>
          <td><span class="status-badge status-${ts.status}">${ts.status}</span></td>
          <td class="num">${total}</td>
          <td class="small muted">${submitted}</td>
          <td><a href="/timesheet.html?week=${ts.week_start}" class="small">View</a></td>
        </tr>
      `;
    }).join("");
  } catch (err) {
    console.error(err);
    notice(err.message || "Failed to load archive", "error");
  }
}

loadArchive();
