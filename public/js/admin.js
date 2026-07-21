// PTL Timesheet Admin page.
// Tabs: Dashboard (donut charts) | Infusion Export (xlsx generation).

import { getSupabase } from "/js/supabase-client.js";
import {
  notice, escapeHtml, renderTopbar, requireAdmin,
  DAYS, DAY_LABELS, getMonday, getActiveMonday, fmtDate, addDays, fmtDMY, fmtHours, leaveTotalHours,
  donutSvg, makeLatestOnly,
  TS_STATUS, isTsSubmittedOrApproved,
  confirmDialog, promptDialog,
  fetchWeekDashboardData, invalidateWeekDashboard,
  isUserEffectiveOverhead,
  flagTruncationRisk,
  skeletonRows, skeletonBlock,
} from "/js/shared.js";

// XLSX is ~600KB. Load only when an Export button is actually clicked.
let _xlsxPromise = null;
function getXLSX() {
  if (!_xlsxPromise) _xlsxPromise = import("https://esm.sh/xlsx@0.18.5");
  return _xlsxPromise;
}
// jsPDF + autotable for the printable Leave/Overtime report. Same lazy-load
// pattern as XLSX — only pulled when the PDF button is clicked. The plugin
// is invoked as a function (autoTable(doc, opts)) rather than as a method
// (doc.autoTable(opts)) because the esm.sh build of jspdf-autotable doesn't
// reliably attach to the jsPDF prototype across module instances.
let _pdfPromise = null;
function getPdf() {
  if (!_pdfPromise) {
    _pdfPromise = (async () => {
      const [jspdfMod, autotableMod] = await Promise.all([
        import("https://esm.sh/jspdf@2.5.1"),
        import("https://esm.sh/jspdf-autotable@3.8.2"),
      ]);
      return { jsPDF: jspdfMod.jsPDF, autoTable: autotableMod.default };
    })();
  }
  return _pdfPromise;
}

const sb = await getSupabase();
const ctx = await requireAdmin(sb);
let currentOrgId = ctx.currentOrgId;

renderTopbar({
  session: ctx.session,
  isDeveloper: ctx.isDeveloper,
  isManager: ctx.isManager,
  isClockViewer: ctx.isClockViewer,
  adminRow: ctx.adminRow,
  orgs: ctx.orgs,
  currentOrgId,
  onOrgChange: (id) => {
    currentOrgId = id;
    localStorage.setItem("ptl-dev-org-id", String(id));
    if (activeTab === "dashboard") navLoadDashboard();
    if (activeTab === "infusion") navLoadInfusionStatus();
  },
  active: "admin",
});

if (!currentOrgId) {
  notice("No organisation on this account — contact a developer.", "error", { sticky: true });
}

/* ---------------------------------------------------------------- helpers */

const thisMonday = getActiveMonday();

/* ---------------------------------------------------------------- tabs */

if (ctx.isDeveloper) {
  const tabBar = document.getElementById("admin-tabs");
  const devBtn = document.createElement("button");
  devBtn.className = "tab";
  devBtn.dataset.tab = "devtools";
  devBtn.textContent = "Dev Tools";
  tabBar.appendChild(devBtn);
}

const VALID_TABS = new Set(["dashboard", "infusion", "leave", "leavereport", "devtools"]);
function tabFromHash() {
  const m = /tab=([a-z]+)/.exec(location.hash);
  const t = m?.[1];
  return VALID_TABS.has(t) ? t : null;
}
let activeTab = tabFromHash() || "dashboard";

function applyActiveTab() {
  document.querySelectorAll("[data-tab]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === activeTab);
  });
  document.getElementById("tab-dashboard").style.display    = activeTab === "dashboard"   ? "" : "none";
  document.getElementById("tab-infusion").style.display     = activeTab === "infusion"    ? "" : "none";
  document.getElementById("tab-leave").style.display        = activeTab === "leave"       ? "" : "none";
  document.getElementById("tab-leavereport").style.display  = activeTab === "leavereport" ? "" : "none";
  document.getElementById("tab-devtools").style.display     = activeTab === "devtools"    ? "" : "none";
  if (activeTab === "dashboard") navLoadDashboard();
  if (activeTab === "infusion") navLoadInfusionStatus();
  if (activeTab === "leave") loadAdminLeave();
  if (activeTab === "leavereport") { if (lvSubView === "waged") loadWagedReport(); else loadSalariedReport(); }
  if (activeTab === "devtools") loadDevToolsForm();
}

document.querySelectorAll("[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    activeTab = btn.dataset.tab;
    history.replaceState(null, "", `#tab=${activeTab}`);
    applyActiveTab();
  });
});

/* ================================================================
 * Dashboard tab
 * ================================================================ */

let dashWeek = new Date(thisMonday);

function updateDashWeekLabel() {
  const end = addDays(dashWeek, 6);
  document.getElementById("week-label").textContent =
    `${dashWeek.toLocaleDateString(undefined, { day: "numeric", month: "short" })} — ${end.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
}
updateDashWeekLabel();

const navLoadDashboard = makeLatestOnly((signal) => loadDashboard(signal));
document.getElementById("dash-prev").addEventListener("click", () => {
  dashWeek = addDays(dashWeek, -7);
  updateDashWeekLabel();
  navLoadDashboard();
});
document.getElementById("dash-next").addEventListener("click", () => {
  dashWeek = addDays(dashWeek, 7);
  updateDashWeekLabel();
  navLoadDashboard();
});

function renderDonut(containerId, submitted, total, fillColor, emptyColor) {
  const el = document.getElementById(containerId);
  el.innerHTML = donutSvg({ submitted, total, fillColor, emptyColor });
}

async function loadDashboard(signal) {
  if (!currentOrgId) return;

  const ws = fmtDate(dashWeek);
  const dash = await fetchWeekDashboardData(sb, currentOrgId, ws);
  if (!dash) return;

  const allDepartments = (dash.departments || []).filter((d) => d.active);
  const deptById = new Map(allDepartments.map((d) => [d.id, d]));
  // Per-user effective-overhead lets a manager in an overhead dept who
  // has their own rate still count toward timesheet rollups. Drop any
  // employee whose effective status is overhead.
  const employees = dash.employees.filter((e) =>
    !isUserEffectiveOverhead(e, deptById.get(e.department_id)));
  // Show a dept on the donut iff it still has at least one non-overhead
  // member after filtering — so Management appears when its rate-having
  // managers are members, stays hidden when only admin/ops people are.
  const remainingDeptIds = new Set(employees.map((e) => e.department_id));
  const departments = allDepartments.filter((d) => remainingDeptIds.has(d.id));
  const tsMap = dash.timesheetsByUserId;
  const hoursMap = dash.hoursByTsId;

  const submittedEmps = employees.filter((e) => isTsSubmittedOrApproved(tsMap[e.id]?.status));
  renderDonut("emp-donut", submittedEmps.length, employees.length, "#BEFA40", "#e8e8e8");
  document.getElementById("emp-legend").innerHTML = `
    <span class="legend-item"><span class="legend-dot" style="background:#BEFA40"></span> Submitted (${submittedEmps.length})</span>
    <span class="legend-item"><span class="legend-dot" style="background:#e8e8e8;border:1px solid #ccc"></span> Not submitted (${employees.length - submittedEmps.length})</span>
  `;

  const empsByDept = new Map();
  for (const e of employees) {
    const list = empsByDept.get(e.department_id);
    if (list) list.push(e);
    else empsByDept.set(e.department_id, [e]);
  }
  const deptSubmitted = departments.filter((d) => {
    const members = empsByDept.get(d.id);
    if (!members || !members.length) return false;
    return members.every((e) => isTsSubmittedOrApproved(tsMap[e.id]?.status));
  });
  renderDonut("dept-donut", deptSubmitted.length, departments.length, "#1a56c7", "#e8e8e8");
  document.getElementById("dept-legend").innerHTML = `
    <span class="legend-item"><span class="legend-dot" style="background:#1a56c7"></span> All submitted (${deptSubmitted.length})</span>
    <span class="legend-item"><span class="legend-dot" style="background:#e8e8e8;border:1px solid #ccc"></span> Pending (${departments.length - deptSubmitted.length})</span>
  `;

  const body = document.getElementById("emp-body");
  if (!employees.length) {
    body.innerHTML = `<tr><td colspan="5" class="muted small" style="text-align:center">No active employees.</td></tr>`;
    return;
  }

  const deptNameById = new Map(departments.map((d) => [d.id, d.name]));
  const deptName = (id) => deptNameById.get(id) || "";

  const wsIso = fmtDate(dashWeek);
  body.innerHTML = employees.map((e) => {
    const ts = tsMap[e.id];
    const hours = ts ? (hoursMap[ts.id] || 0) : 0;

    let badge, badgeClass;
    if (ts?.status === "exported") {
      badge = "Exported";
      badgeClass = "dept-badge dept-badge-exported";
    } else if (ts?.status === "approved") {
      badge = "Approved";
      badgeClass = "dept-badge dept-badge-approved";
    } else if (ts?.status === "submitted") {
      badge = "Submitted";
      badgeClass = "dept-badge dept-badge-submitted";
    } else if (ts?.status === "rejected") {
      badge = "Rejected";
      badgeClass = "dept-badge dept-badge-rejected";
    } else if (ts?.status === "draft") {
      badge = "Draft";
      badgeClass = "dept-badge dept-badge-draft";
    } else {
      badge = "Not submitted";
      badgeClass = "dept-badge dept-badge-none";
    }

    // View if a timesheet exists, otherwise let the admin create one.
    // The "Create" link opens the timesheet editor in admin-override
    // mode, which calls admin_get_or_create_timesheet to materialise
    // a draft on first save.
    const viewCell = ts
      ? `<a href="/timesheet-view.html?user=${e.id}&week=${wsIso}&return=admin" class="ghost small" style="padding:3px 10px;border-radius:999px;border:1px solid var(--border);text-decoration:none">View</a>`
      : `<a href="/timesheet.html?user=${e.id}&week=${wsIso}&admin=1&return=${encodeURIComponent("/admin.html#tab=infusion")}" class="ghost small" style="padding:3px 10px;border-radius:999px;border:1px solid var(--border);text-decoration:none">Create</a>`;

    return `
      <tr>
        <td>${escapeHtml(e.name)}</td>
        <td class="muted small">${escapeHtml(deptName(e.department_id))}</td>
        <td><span class="${badgeClass}">${badge}</span></td>
        <td class="small">${hours ? fmtHours(hours) : ""}</td>
        <td>${viewCell}</td>
      </tr>`;
  }).join("");
}

/* ================================================================
 * Timesheet vs Clock tab moved to the standalone /timeclock.html
 * page. Kept that page's loader self-contained — see js/timeclock.js.
 * ================================================================ */


/* ================================================================
 * Infusion Export tab
 * ================================================================ */

let infWeek = new Date(thisMonday);
let infRows = [];
let infSubmittedCount = 0;
let infDecidedCount = 0;
// Pending = submitted but not yet approved or rejected. Hard-blocks export.
let infPendingDecisionCount = 0;
// Missing = no timesheet at all, or status === draft. Soft-warns on export.
let infMissingCount = 0;
let infTotalEmps = 0;
// Cached employees + timesheets for the current week so the approval list
// can render and act without re-fetching.
let infEmployees = [];
let infDeptNameById = {};
let infTsMap = {};
let approvalWorkflow = "manager_then_admin";

let clockTolerance = 0.5;

let orgSettingsPromise = null;
function loadOrgSettings() {
  if (orgSettingsPromise) return orgSettingsPromise;
  orgSettingsPromise = (async () => {
    if (!currentOrgId) return;
    try {
      const { data } = await sb
        .from("organisations")
        .select("approval_workflow, clock_tolerance_hours")
        .eq("id", currentOrgId)
        .maybeSingle();
      approvalWorkflow = data?.approval_workflow || "manager_then_admin";
      if (data?.clock_tolerance_hours != null) clockTolerance = Number(data.clock_tolerance_hours);
    } catch (err) {
      console.warn("approval workflow settings load failed:", err);
      notice("Couldn't load org settings — approval workflow + clock tolerance may be wrong", "warn");
    }
  })();
  return orgSettingsPromise;
}

// Developer-only audit info combining two sources:
//   - infusion_export_row_counts RPC (live): tells us how many rows are
//     currently exportable, split by already-exported vs pending. For a
//     fully-exported past week this number IS what was sent to Infusion
//     — compare against the downloaded XLSX to verify accuracy even when
//     no log entry exists (i.e. exports done before migration 124).
//   - infusion_export_logs table: the historical log of every export run
//     and the row count it produced. Lets us see drift between runs.
async function renderExportLogInfo(weekStartIso) {
  const infoEl = document.getElementById("inf-export-log-info");
  if (!infoEl) return;
  infoEl.style.display = "";
  infoEl.textContent = "Loading export log…";
  try {
    const [countsRes, logsRes] = await Promise.all([
      sb.rpc("infusion_export_row_counts", {
        p_org_id: currentOrgId,
        p_week_start: weekStartIso,
      }),
      sb.from("infusion_export_logs")
        .select("row_count, exported_at, exported_by, users:exported_by (name)")
        .eq("organisation_id", currentOrgId)
        .eq("week_start", weekStartIso)
        .order("exported_at", { ascending: false }),
    ]);

    const countsRow = Array.isArray(countsRes.data) ? countsRes.data[0] : countsRes.data;
    const exportedNow = Number(countsRow?.already_exported) || 0;
    const pendingNow  = Number(countsRow?.pending_approved) || 0;
    const logs = logsRes.data || [];

    const parts = [];
    if (exportedNow > 0) {
      parts.push(`Exported state: <strong>${exportedNow.toLocaleString()}</strong> row${exportedNow === 1 ? "" : "s"}`);
    }
    if (pendingNow > 0) {
      parts.push(`Pending approval/export: <strong>${pendingNow.toLocaleString()}</strong> row${pendingNow === 1 ? "" : "s"}`);
    }
    if (parts.length === 0) {
      parts.push("No exportable rows for this week (no approved or exported timesheets).");
    }

    let logLine = "";
    if (logs.length) {
      const latest = logs[0];
      const when = new Date(latest.exported_at).toLocaleString();
      const who = latest.users?.name || "—";
      const reruns = logs.length > 1 ? ` · ${logs.length} runs total` : "";
      const match = Number(latest.row_count) === exportedNow ? " ✓" : " ⚠ count differs";
      logLine = `<br>Last logged export: <strong>${Number(latest.row_count).toLocaleString()}</strong> rows · ${escapeHtml(when)} · ${escapeHtml(who)}${reruns}${match}`;
    } else if (exportedNow > 0) {
      logLine = `<br><span style="color:var(--text-muted)">No log entry (export ran before audit logging was enabled). Open the downloaded XLSX and confirm it has <strong>${exportedNow.toLocaleString()}</strong> data rows.</span>`;
    }

    infoEl.innerHTML = `🛠 ${parts.join(" · ")}${logLine}`;
  } catch (err) {
    infoEl.innerHTML = `🛠 Export log unavailable (${escapeHtml(err.message || "")})`;
  }
}

function updateInfusionWeekLabel() {
  const end = addDays(infWeek, 6);
  document.getElementById("inf-week-label").textContent =
    `${infWeek.toLocaleDateString(undefined, { day: "numeric", month: "short" })} — ${end.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
}

async function loadInfusionStatus(signal) {
  const barsEl = document.getElementById("inf-status-bars");
  if (!currentOrgId) { barsEl.innerHTML = ""; return; }

  // approvalWorkflow drives whether the dept-bar group renders below; awaiting
  // here mirrors loadClockComparison and avoids reading a default mid-init.
  await loadOrgSettings();

  const ws = fmtDate(infWeek);
  // Developer-only: pull the export history for this week and render a
  // small audit line above the status bars. Used to spot regressions in
  // the export pipeline (e.g. row count dropping unexpectedly between
  // runs would suggest data loss).
  if (ctx.isDeveloper) {
    void renderExportLogInfo(ws);
  }
  const dash = await fetchWeekDashboardData(sb, currentOrgId, ws);
  if (!dash) { barsEl.innerHTML = ""; return; }

  const allInfDepts = dash.departments.filter((d) => d.active);
  const infDeptById = new Map(allInfDepts.map((d) => [d.id, d]));
  const employees = dash.employees.filter((e) =>
    !isUserEffectiveOverhead(e, infDeptById.get(e.department_id)));
  const remainingDeptIds = new Set(employees.map((e) => e.department_id));
  const departments = allInfDepts.filter((d) => remainingDeptIds.has(d.id));
  const tsMap = dash.timesheetsByUserId;

  infTotalEmps = employees.length;
  // Exported timesheets advance the same bars as submitted/approved —
  // exporting just means "this approved week was written to Excel".
  // They render as a blue segment so admins can still see at a glance
  // how much of the bar is post-export.
  const infExportedCount = employees.filter((e) => {
    const ts = tsMap[e.id];
    return ts && ts.status === TS_STATUS.EXPORTED;
  }).length;
  infSubmittedCount = employees.filter((e) => {
    const ts = tsMap[e.id];
    return ts && (ts.status === "submitted" || ts.status === "approved" || ts.status === TS_STATUS.EXPORTED);
  }).length;
  // "Decided" = the admin has either approved or rejected the timesheet.
  // Exported counts as decided (it was approved first).
  infDecidedCount = employees.filter((e) => {
    const ts = tsMap[e.id];
    return ts && (ts.status === TS_STATUS.APPROVED || ts.status === TS_STATUS.REJECTED || ts.status === TS_STATUS.EXPORTED);
  }).length;
  // Pending = submitted but no decision yet. Blocks export hard.
  infPendingDecisionCount = employees.filter((e) => {
    const ts = tsMap[e.id];
    return ts && ts.status === TS_STATUS.SUBMITTED;
  }).length;
  // Missing = never submitted, or still draft. Soft-warn at export time.
  infMissingCount = employees.filter((e) => {
    const ts = tsMap[e.id];
    return !ts || ts.status === TS_STATUS.DRAFT;
  }).length;
  // Stash for the approval list renderer.
  infEmployees = employees;
  infTsMap = tsMap;
  // Department names keyed by id, so the approval list can show a
  // dept name per row without re-querying. (infTsMap is the timesheet
  // map by user_id — it has no department_name column.)
  infDeptNameById = Object.fromEntries(allInfDepts.map((d) => [d.id, d.name]));

  // Split each bar into a green (non-exported) and blue (exported)
  // segment. Green is the portion that's met the bar's criterion but
  // hasn't been exported yet; blue is the portion that's been exported.
  const greenSubmittedCount = infSubmittedCount - infExportedCount;
  const greenSubmittedPct = infTotalEmps === 0 ? 0 : Math.round((greenSubmittedCount / infTotalEmps) * 100);
  const exportedPct = infTotalEmps === 0 ? 0 : Math.round((infExportedCount / infTotalEmps) * 100);
  const allSubmitted = infSubmittedCount === infTotalEmps && infTotalEmps > 0;

  // "Approved" counters mirror the submitted ones but use a stricter rule
  // - only status === approved counts toward the green segment. Rejected
  // timesheets are decided but not approved, so they do NOT advance the
  // bar. Exported counts as approved+done (blue segment).
  const infApprovedCount = employees.filter((e) => {
    const ts = tsMap[e.id];
    return ts && ts.status === TS_STATUS.APPROVED;
  }).length;
  const empApprovedPct = infTotalEmps === 0 ? 0 : Math.round((infApprovedCount / infTotalEmps) * 100);
  const allApproved = (infApprovedCount + infExportedCount) === infTotalEmps && infTotalEmps > 0;
  const approvedTotal = infApprovedCount + infExportedCount;

  let html = `
    <div class="inf-bar-group">
      <div class="row-flex" style="gap:8px;margin-bottom:4px">
        <span class="small" style="font-weight:600">Employees submitted</span>
        <div class="grow"></div>
        <span class="small ${allSubmitted ? "" : "warn-text"}" style="font-weight:600">${infSubmittedCount} / ${infTotalEmps}</span>
      </div>
      <div class="ts-progress-bar">
        <div class="ts-progress-fill submitted" style="width:${greenSubmittedPct}%"></div>
        <div class="ts-progress-fill exported"  style="width:${exportedPct}%"></div>
      </div>
    </div>
    <div class="inf-bar-group" style="margin-top:12px">
      <div class="row-flex" style="gap:8px;margin-bottom:4px">
        <span class="small" style="font-weight:600">Employees approved</span>
        <div class="grow"></div>
        <span class="small ${allApproved ? "" : "warn-text"}" style="font-weight:600">${approvedTotal} / ${infTotalEmps}</span>
      </div>
      <div class="ts-progress-bar">
        <div class="ts-progress-fill submitted" style="width:${empApprovedPct}%"></div>
        <div class="ts-progress-fill exported"  style="width:${exportedPct}%"></div>
      </div>
    </div>
  `;

  if (approvalWorkflow === "manager_then_admin") {
    const empsByDept = new Map();
    for (const e of employees) {
      const list = empsByDept.get(e.department_id);
      if (list) list.push(e);
      else empsByDept.set(e.department_id, [e]);
    }
    // A dept is "fully exported" when every member's timesheet is exported.
    // It counts toward the blue segment of both bars. Otherwise, if every
    // member meets the bar's criterion, it counts toward the green segment.
    const deptIsFullyExported = (d) => {
      const members = empsByDept.get(d.id);
      if (!members || !members.length) return false;
      return members.every((e) => tsMap[e.id]?.status === TS_STATUS.EXPORTED);
    };
    const deptSubmittedAll = departments.filter((d) => {
      const members = empsByDept.get(d.id);
      if (!members || !members.length) return false;
      return members.every((e) => isTsSubmittedOrApproved(tsMap[e.id]?.status));
    });
    // Dept approved = every member is approved or exported (exported is
    // approved + done). Strict - one rejected/submitted member fails.
    const deptApprovedAll = departments.filter((d) => {
      const members = empsByDept.get(d.id);
      if (!members || !members.length) return false;
      return members.every((e) =>
        tsMap[e.id]?.status === TS_STATUS.APPROVED ||
        tsMap[e.id]?.status === TS_STATUS.EXPORTED);
    });
    const deptExportedCount = departments.filter(deptIsFullyExported).length;

    const deptTotal = departments.length;
    const deptSubmittedCount = deptSubmittedAll.length;
    const deptSubmittedGreen = deptSubmittedCount - deptExportedCount;
    const deptSubmittedGreenPct = deptTotal === 0 ? 0 : Math.round((deptSubmittedGreen / deptTotal) * 100);
    const deptExportedPct = deptTotal === 0 ? 0 : Math.round((deptExportedCount / deptTotal) * 100);
    const allDepts = deptSubmittedCount === deptTotal && deptTotal > 0;

    const deptApprovedCount = deptApprovedAll.length;
    const deptApprovedGreen = deptApprovedCount - deptExportedCount;
    const deptApprovedGreenPct = deptTotal === 0 ? 0 : Math.round((deptApprovedGreen / deptTotal) * 100);
    const allDeptsApproved  = deptApprovedCount === deptTotal && deptTotal > 0;

    html += `
      <div class="inf-bar-group" style="margin-top:12px">
        <div class="row-flex" style="gap:8px;margin-bottom:4px">
          <span class="small" style="font-weight:600">Departments submitted</span>
          <div class="grow"></div>
          <span class="small ${allDepts ? "" : "warn-text"}" style="font-weight:600">${deptSubmittedCount} / ${deptTotal}</span>
        </div>
        <div class="ts-progress-bar">
          <div class="ts-progress-fill submitted" style="width:${deptSubmittedGreenPct}%"></div>
          <div class="ts-progress-fill exported"  style="width:${deptExportedPct}%"></div>
        </div>
      </div>
      <div class="inf-bar-group" style="margin-top:12px">
        <div class="row-flex" style="gap:8px;margin-bottom:4px">
          <span class="small" style="font-weight:600">Departments approved</span>
          <div class="grow"></div>
          <span class="small ${allDeptsApproved ? "" : "warn-text"}" style="font-weight:600">${deptApprovedCount} / ${deptTotal}</span>
        </div>
        <div class="ts-progress-bar">
          <div class="ts-progress-fill submitted" style="width:${deptApprovedGreenPct}%"></div>
          <div class="ts-progress-fill exported"  style="width:${deptExportedPct}%"></div>
        </div>
      </div>
    `;
  }

  barsEl.innerHTML = html;
  renderInfusionApprovalList();
}

// Renders the "Pending decisions" card on the Infusion tab. One row per
// employee whose timesheet is still in 'submitted' status. Admins can
// approve or reject each row individually, or hit "Approve all" to
// approve everything at once. Reads from the cached infEmployees /
// infTsMap populated by loadInfusionStatus.
function renderInfusionApprovalList() {
  const listEl = document.getElementById("inf-approval-list");
  const countEl = document.getElementById("inf-approval-count");
  const approveAllBtn = document.getElementById("inf-approve-all-btn");
  if (!listEl || !countEl || !approveAllBtn) return;

  const pending = infEmployees.filter((e) => {
    const ts = infTsMap[e.id];
    return ts && ts.status === TS_STATUS.SUBMITTED;
  });

  if (!pending.length) {
    listEl.innerHTML = `<p class="muted small" style="text-align:center;margin:0">All submitted timesheets are decided.</p>`;
    countEl.textContent = "";
    approveAllBtn.disabled = true;
    return;
  }

  countEl.textContent = `${pending.length} awaiting decision`;
  approveAllBtn.disabled = false;

  listEl.innerHTML = `
    <table class="small" style="width:100%">
      <thead>
        <tr><th style="text-align:left">Employee</th><th style="text-align:left">Department</th><th></th></tr>
      </thead>
      <tbody>
        ${pending.map((e) => {
          // Resolve via the departments cache; the timesheets row doesn't
          // carry the dept name and the employees row only carries the id.
          const deptName = infDeptNameById[e.department_id] || "";
          const tsId = infTsMap[e.id].id;
          return `
            <tr>
              <td>${escapeHtml(e.name || "")}</td>
              <td class="muted">${escapeHtml(deptName)}</td>
              <td style="white-space:nowrap;text-align:right">
                <a href="/timesheet-view.html?user=${e.id}&week=${fmtDate(infWeek)}&return=admin" class="dept-view-btn">View</a>
                <button class="approve-btn" data-ts-id="${tsId}" data-user-id="${e.id}">Approve</button>
                <button class="reject-btn ghost" data-ts-id="${tsId}" data-user-id="${e.id}">Reject</button>
              </td>
            </tr>`;
        }).join("")}
      </tbody>
    </table>`;

  listEl.querySelectorAll(".approve-btn").forEach((btn) => {
    btn.addEventListener("click", () => decideInfusionTimesheet(Number(btn.dataset.tsId), "approved"));
  });
  listEl.querySelectorAll(".reject-btn").forEach((btn) => {
    btn.addEventListener("click", () => decideInfusionTimesheet(Number(btn.dataset.tsId), "rejected"));
  });
}

async function decideInfusionTimesheet(tsId, newStatus) {
  const verb = newStatus === "approved" ? "Approve" : "Reject";
  if (!await confirmDialog({
    title: `${verb} timesheet`,
    message: `${verb} this timesheet?`,
    confirmText: verb,
  })) return;
  const { data: rows, error } = await sb
    .from("timesheets")
    .update({ status: newStatus })
    .eq("id", tsId)
    .eq("status", "submitted")
    .select("id");
  if (error) return notice(error.message, "error");
  if (!rows?.length) {
    notice("Already actioned by someone else", "warn");
  } else {
    notice(`Timesheet ${newStatus === "approved" ? "approved" : "rejected"}`, "success");
  }
  invalidateWeekDashboard(currentOrgId, fmtDate(infWeek));
  await loadInfusionStatus();
}

// Approve-all: bulk-update every submitted timesheet for the active
// non-overhead employees in this week. One round trip via .in("user_id").
// RLS still gates the update so this is admin-only behaviourally even
// though the button only renders on the admin page.
document.getElementById("inf-approve-all-btn").addEventListener("click", async () => {
  const pendingUserIds = infEmployees
    .filter((e) => infTsMap[e.id]?.status === TS_STATUS.SUBMITTED)
    .map((e) => e.id);
  if (!pendingUserIds.length) return;
  if (!await confirmDialog({
    title: "Approve all submitted",
    message: `Approve ${pendingUserIds.length} submitted timesheet${pendingUserIds.length === 1 ? "" : "s"} at once?`,
    confirmText: "Approve all",
  })) return;
  const ws = fmtDate(infWeek);
  const { data, error } = await sb
    .from("timesheets")
    .update({ status: "approved" })
    .eq("organisation_id", currentOrgId)
    .eq("week_start", ws)
    .eq("status", "submitted")
    .in("user_id", pendingUserIds)
    .select("id");
  if (error) return notice(error.message, "error");
  notice(`Approved ${data?.length ?? 0} timesheet${(data?.length ?? 0) === 1 ? "" : "s"}`, "success");
  invalidateWeekDashboard(currentOrgId, ws);
  await loadInfusionStatus();
});

const navLoadInfusionStatus = makeLatestOnly((signal) => loadInfusionStatus(signal));

document.getElementById("inf-prev").addEventListener("click", () => {
  infWeek = addDays(infWeek, -7);
  updateInfusionWeekLabel();
  infRows = [];
  navLoadInfusionStatus();
});
document.getElementById("inf-next").addEventListener("click", () => {
  infWeek = addDays(infWeek, 7);
  updateInfusionWeekLabel();
  infRows = [];
  navLoadInfusionStatus();
});

updateInfusionWeekLabel();

async function buildInfusionRows() {
  if (!currentOrgId) return [];

  const ws = fmtDate(infWeek);

  // Reuse the cached dashboard data for users / departments / timesheets,
  // then fetch only the extra columns (rate fields, employee_code) keyed
  // by id and merge them in. Saves three full org-scoped fetches per
  // export when the user is also viewing the dashboard or infusion-status
  // panel.
  const dash = await fetchWeekDashboardData(sb, currentOrgId, ws);
  if (!dash) return [];

  // Only approved rows are exportable. Already-exported rows (terminal
  // status) are skipped so the second click for late submissions only
  // picks up the new approvals.
  const timesheets = dash.timesheets.filter((t) => t.status === "approved");
  if (!timesheets.length) return [];

  const empIds = dash.employees.map((e) => e.id);
  const deptIds = dash.departments.map((d) => d.id);

  const [empExtraRes, deptExtraRes] = await Promise.all([
    empIds.length
      ? sb.from("users").select("id, employee_code, cost_rate, sell_rate, rate_source_department_id").in("id", empIds)
      : Promise.resolve({ data: [] }),
    deptIds.length
      ? sb.from("departments").select("id, cost_rate, sell_rate").in("id", deptIds)
      : Promise.resolve({ data: [] }),
  ]);

  const empExtraById = new Map((empExtraRes.data || []).map((r) => [r.id, r]));
  const deptExtraById = new Map((deptExtraRes.data || []).map((r) => [r.id, r]));

  const employees = dash.employees.map((e) => ({ ...e, ...(empExtraById.get(e.id) || {}) }));
  const departments = dash.departments.map((d) => ({ ...d, ...(deptExtraById.get(d.id) || {}) }));

  const tsIds = timesheets.map((t) => t.id);

  // Load entries with the related lookup codes inlined via PostgREST joins.
  // Chunked by timesheet_id to stay under Supabase's 1000-row select cap.
  // A busy week at PTL scale (~70 staff × ~15 entries) can exceed 1000 in
  // a single .in() call; the cap silently drops anything past row 1000 —
  // which on this code path would mean missing payroll lines in the
  // Infusion export. 50 timesheets per chunk → ~500 entries per request
  // even on heavy weeks, comfortably under the cap.
  const ENTRY_CHUNK = 50;
  const entries = [];
  for (let i = 0; i < tsIds.length; i += ENTRY_CHUNK) {
    const slice = tsIds.slice(i, i + ENTRY_CHUNK);
    const { data: chunk, error } = await sb
      .from("timesheet_entries")
      .select("id, timesheet_id, job_id, task_id, dept_code_id, description, mon_hours, tue_hours, wed_hours, thu_hours, fri_hours, sat_hours, sun_hours, jobs(id, job_code), tasks(id, task_code), department_codes(id, code)")
      .in("timesheet_id", slice)
      .order("id");
    if (error) throw error;
    flagTruncationRisk(chunk?.length, "Infusion export entries");
    if (chunk?.length) entries.push(...chunk);
  }

  const empMap = {};
  for (const e of employees || []) empMap[e.id] = e;
  const deptMap = {};
  for (const d of departments || []) deptMap[d.id] = d;
  const tsUserMap = {};
  for (const t of timesheets) tsUserMap[t.id] = t.user_id;

  function effectiveRate(emp, field) {
    // 1. Explicit rate-source department wins (e.g. managers who bill
    //    at another department's rate).
    if (emp.rate_source_department_id) {
      const src = deptExtraById.get(emp.rate_source_department_id);
      if (src && src[field] != null) return Number(src[field]);
    }
    // 2. Per-user override.
    if (emp[field] != null) return Number(emp[field]);
    // 3. Fall through to the employee's own department default.
    const dept = emp.department_id ? deptMap[emp.department_id] : null;
    if (dept && !dept.is_overhead && dept[field] != null) return Number(dept[field]);
    return 0;
  }

  // Build rows: for each entry, for each day, one row
  const rows = [];
  for (const entry of entries || []) {
    const userId = tsUserMap[entry.timesheet_id];
    const emp = empMap[userId];
    if (!emp) continue;

    const jobCode = entry.jobs?.job_code || "";
    const taskCode = entry.tasks?.task_code || "";
    const deptCode = entry.department_codes?.code || "";
    const desc = taskCode
      ? (entry.description ? `${taskCode}-${entry.description}` : taskCode)
      : (entry.description || "");
    const costRate = effectiveRate(emp, "cost_rate");
    const sellRate = effectiveRate(emp, "sell_rate");

    for (let i = 0; i < 7; i++) {
      const dayDate = addDays(infWeek, i);
      const dayKey = DAYS[i];
      const qty = Number(entry[`${dayKey}_hours`]) || 0;
      if (qty === 0) continue;

      rows.push({
        "Transaction No": 6,
        "jobid": jobCode,
        "date": fmtDMY(dayDate),
        "employee name": emp.name || "",
        "desc": desc,
        "code": emp.employee_code || "",
        "rate": costRate,
        "qty": qty,
        "sell": sellRate,
        "empty1": "",
        "empty2": "",
        "empty3": "",
        "dept": deptCode,
      });
    }
  }

  rows.sort((a, b) => a["employee name"].localeCompare(b["employee name"]) || a["date"].split("/").reverse().join("").localeCompare(b["date"].split("/").reverse().join("")));
  return rows;
}

// Preview
document.getElementById("inf-preview-btn").addEventListener("click", async () => {
  const preview = document.getElementById("inf-preview");
  const summary = document.getElementById("inf-summary");
  preview.innerHTML = skeletonBlock();

  try {
    infRows = await buildInfusionRows();
    summary.textContent = `${infRows.length} rows`;

    if (!infRows.length) {
      preview.innerHTML = `<p class="muted small" style="text-align:center">No timesheets found for this week.</p>`;
      return;
    }

    const maxPreview = 100;
    const showing = infRows.slice(0, maxPreview);

    preview.innerHTML = `
      <table class="small">
        <thead>
          <tr>
            <th>Trans.</th><th>Job ID</th><th>Date</th><th>Employee</th>
            <th>Description</th><th>Code</th><th>Rate</th><th>Qty</th>
            <th>Sell</th><th colspan="3"></th><th>Dept</th>
          </tr>
        </thead>
        <tbody>
          ${showing.map((r) => `
            <tr>
              <td>${r["Transaction No"]}</td>
              <td>${escapeHtml(r.jobid)}</td>
              <td class="nowrap">${r.date}</td>
              <td>${escapeHtml(r["employee name"])}</td>
              <td>${escapeHtml(r.desc)}</td>
              <td>${escapeHtml(r.code)}</td>
              <td>${r.rate}</td>
              <td>${r.qty}</td>
              <td>${r.sell}</td>
              <td></td><td></td><td></td>
              <td>${escapeHtml(r.dept)}</td>
            </tr>
          `).join("")}
          ${infRows.length > maxPreview ? `<tr><td colspan="13" class="muted small" style="text-align:center">…and ${infRows.length - maxPreview} more rows</td></tr>` : ""}
        </tbody>
      </table>
    `;
  } catch (err) {
    preview.innerHTML = `<p class="muted small" style="text-align:center">Error: ${escapeHtml(err.message)}</p>`;
  }
});

// Export
document.getElementById("inf-export-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("inf-status");

  // Hard block: every submitted timesheet must be approved or rejected
  // before the export. Decline / approve in the "Pending decisions" card
  // above. No override - undecided submissions are not exportable.
  if (infPendingDecisionCount > 0) {
    notice(
      `${infPendingDecisionCount} submitted timesheet${infPendingDecisionCount === 1 ? "" : "s"} ` +
      `still awaiting a decision. Approve or reject each one in the "Pending decisions" card above before exporting.`,
      "error",
    );
    statusEl.textContent = "";
    return;
  }
  // Soft warn: employees who never submitted (or are still in draft).
  // Admin can choose to proceed - those rows simply won't appear in the
  // export (no entries to push).
  if (infMissingCount > 0) {
    if (!await confirmDialog({
      title: "Export with missing timesheets",
      message: `${infMissingCount} employee${infMissingCount === 1 ? " hasn't" : "s haven't"} submitted a timesheet for this week. Export anyway?`,
      confirmText: "Export",
    })) {
      statusEl.textContent = "";
      return;
    }
  }

  statusEl.textContent = "Generating…";

  try {
    if (!infRows.length) {
      infRows = await buildInfusionRows();
    }

    if (!infRows.length) {
      notice("No data to export for this week", "warn");
      statusEl.textContent = "";
      return;
    }

    const wsData = [];
    for (const r of infRows) {
      wsData.push([
        r["Transaction No"],
        r.jobid,
        r.date,
        r["employee name"],
        r.desc,
        r.code,
        r.rate,
        r.qty,
        r.sell,
        "", "", "",
        r.dept,
      ]);
    }

    const XLSX = await getXLSX();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Infusion");

    const weekLabel = fmtDate(infWeek);
    XLSX.writeFile(wb, `infusion-export-${weekLabel}.xlsx`);

    // Log the row count for the developer audit trail (migration 124).
    // Best-effort: if the RPC fails or the migration isn't applied, the
    // export itself is already on disk and we don't want to surface a
    // misleading error.
    try {
      await sb.rpc("log_infusion_export", {
        p_org_id: currentOrgId,
        p_week_start: fmtDate(infWeek),
        p_row_count: wsData.length,
      });
    } catch (err) {
      console.warn("log_infusion_export failed:", err);
    }

    // After the file is written, flip every approved timesheet for the
    // exported week to 'exported'. Re-runs (late submissions) pick up
    // only the new approvals. If the update fails we still show success
    // because the file did go out — admin can retry the export, the
    // already-downloaded file's data will still match.
    try {
      const { error: stampErr } = await sb
        .from("timesheets")
        .update({ status: "exported" })
        .eq("organisation_id", currentOrgId)
        .eq("week_start", fmtDate(infWeek))
        .eq("status", "approved");
      if (stampErr) console.warn("flip approved -> exported failed:", stampErr.message);
    } catch (err) {
      console.warn("flip approved -> exported threw:", err);
    }

    statusEl.textContent = "Done";
    notice(`Exported ${infRows.length} rows`, "success");
    invalidateWeekDashboard(currentOrgId, fmtDate(infWeek));
    infRows = [];
    navLoadInfusionStatus();
    setTimeout(() => statusEl.textContent = "", 3000);
  } catch (err) {
    notice(err.message || "Export failed", "error");
    statusEl.textContent = "";
  }
});

/* ================================================================
 * Leave / Overtime Report tab
 * ================================================================ */

/* ---------- sub-tab switching ---------- */

let lvSubView = "waged";

document.querySelectorAll("[data-lv-view]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-lv-view]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    lvSubView = btn.dataset.lvView;
    document.getElementById("lv-waged").style.display = lvSubView === "waged" ? "" : "none";
    document.getElementById("lv-salaried").style.display = lvSubView === "salaried" ? "" : "none";
    document.getElementById("lv-custom").style.display = lvSubView === "custom" ? "" : "none";
    closeLvcMenu();
    if (lvSubView === "waged") loadWagedReport();
    if (lvSubView === "salaried") loadSalariedReport();
    if (lvSubView === "custom" && !lvCustomLoaded) loadCustomReport();
  });
});

/* ---------- shared: build per-day leave/OT rows for a set of week_starts ---------- */

// Pulls approved leave for OVERHEAD staff (who don't file timesheets)
// from leave_requests and pushes one report row per leave day into
// `rows`. Timesheet staff are skipped — their leave comes through their
// timesheet entries instead, so including them here would double-count.
async function appendOverheadLeaveRows(rows, { weekStarts, empMap, deptMap, jobMap, filteredEmpIds }) {
  // Report date window = the span covered by the requested week starts.
  const sorted = [...weekStarts].sort();
  const rangeStart = sorted[0];
  const lastMon = new Date(sorted[sorted.length - 1] + "T00:00:00");
  const rangeEnd = fmtDate(addDays(lastMon, 6));

  // Leave types → mapped job (for the code/description columns).
  const { data: leaveTypes } = await sb
    .from("leave_types")
    .select("id, code, name, job_id")
    .eq("organisation_id", currentOrgId);
  const ltById = {};
  for (const t of leaveTypes || []) ltById[t.id] = t;

  // Approved leave overlapping the window.
  const { data: reqs, error } = await sb
    .from("leave_requests")
    .select("id, user_id, leave_type_id, start_date, end_date, hours_per_day, skip_weekends, reason, status")
    .eq("organisation_id", currentOrgId)
    .eq("status", "approved")
    .lte("start_date", rangeEnd)
    .gte("end_date", rangeStart);
  if (error) { console.warn("overhead leave fetch failed:", error.message); return; }

  for (const req of reqs || []) {
    const emp = empMap[req.user_id];
    if (!emp) continue;
    if (!filteredEmpIds.has(emp.id)) continue;
    const dept = emp.department_id ? deptMap[emp.department_id] : null;
    // Only overhead staff — timesheet staff get their leave from the
    // timesheet-entry path.
    if (!isUserEffectiveOverhead(emp, dept)) continue;

    const lt = ltById[req.leave_type_id] || null;
    const job = lt?.job_id ? jobMap[lt.job_id] : null;
    const hours = Number(req.hours_per_day) || 0;
    if (hours <= 0) continue;

    let d = new Date(req.start_date + "T00:00:00");
    const end = new Date(req.end_date + "T00:00:00");
    while (d <= end) {
      const iso = fmtDate(d);
      const dow = d.getDay(); // 0=Sun, 6=Sat
      const isWeekend = dow === 0 || dow === 6;
      // Clip to the report window and respect skip_weekends.
      if (iso >= rangeStart && iso <= rangeEnd && !(req.skip_weekends && isWeekend)) {
        rows.push({
          employee: emp.name || "",
          employee_code: emp.employee_code || "",
          department: dept?.name || "",
          employment_type: emp.employment_type || "",
          date: iso,
          date_display: d.toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" }),
          event: "Leave",
          event_detail: job?.job_code || lt?.code || "",
          event_description: lt?.name || job?.description || "",
          note: req.reason || "",
          hours,
        });
      }
      d = addDays(d, 1);
    }
  }
}

async function buildLeaveRowsForWeeks(weekStarts, typeFilter, includeDrafts) {
  if (!currentOrgId || !weekStarts.length) return [];

  const { data: employees } = await sb
    .from("users")
    .select("id, name, employee_code, department_id, employment_type, receives_overtime, overtime_threshold_hours, overtime_daily_threshold_hours, cost_rate, sell_rate, rate_source_department_id, active")
    .eq("organisation_id", currentOrgId)
    .eq("active", true);

  const { data: departments } = await sb
    .from("departments")
    .select("id, name, is_overhead")
    .eq("organisation_id", currentOrgId);

  // Only fetch leave-flagged jobs. Orgs with thousands of synced
  // Infusion jobs would otherwise blow past Supabase's default 1000-row
  // limit and silently drop the (much rarer) leave jobs from the set,
  // making leave entries invisible in the report.
  const { data: allJobs } = await sb
    .from("jobs")
    .select("id, job_code, description, is_leave")
    .eq("organisation_id", currentOrgId)
    .eq("is_leave", true);

  const leaveJobIds = new Set((allJobs || []).filter((j) => j.is_leave).map((j) => j.id));
  const jobMap = {};
  for (const j of allJobs || []) jobMap[j.id] = j;

  const empMap = {};
  for (const e of employees || []) empMap[e.id] = e;
  const deptMap = {};
  for (const d of departments || []) deptMap[d.id] = d;

  // Filter by employment type (waged vs salaried).
  const filteredEmpIds = new Set(
    (employees || []).filter((e) => !typeFilter || e.employment_type === typeFilter).map((e) => e.id)
  );

  const rows = [];

  // --- Overhead-staff leave (from leave_requests, not timesheets) ------
  // Overhead staff don't file timesheets, so their approved leave never
  // reaches the timesheet-entry path below. Pull it straight from
  // approved leave_requests. Timesheet staff are intentionally excluded
  // here — their leave already shows via their timesheet entries, and
  // including both would double-count.
  await appendOverheadLeaveRows(rows, {
    weekStarts, empMap, deptMap, jobMap, filteredEmpIds,
  });

  let tsQuery = sb
    .from("timesheets")
    .select("id, user_id, status, week_start")
    .eq("organisation_id", currentOrgId)
    .in("week_start", weekStarts);
  if (!includeDrafts) {
    // Include 'exported' too — once a week is exported (admin pressed
    // Export to Excel) the status flips off 'approved', and we still
    // want that leave to appear in the leave report.
    tsQuery = tsQuery.in("status", ["submitted", "approved", "exported"]);
  }
  const { data: timesheets } = await tsQuery;
  if (!timesheets?.length) return rows;

  const tsIds = timesheets.map((t) => t.id);
  const tsMap = {};
  for (const t of timesheets) tsMap[t.id] = { user_id: t.user_id, week_start: t.week_start };

  // Chunk the entries fetch — Supabase caps a single .in() select at
  // 1000 rows by default, and the monthly salaried report pulls ~70
  // staff × ~10 entries × ~5 weeks ≈ 3500 rows. Anything past the
  // 1000th row gets silently dropped, which is how a sick-leave entry
  // can sit on a real timesheet and never reach the report. A chunk
  // of 50 timesheets keeps each request comfortably under 1000.
  const ENTRY_CHUNK = 50;
  const entries = [];
  for (let i = 0; i < tsIds.length; i += ENTRY_CHUNK) {
    const slice = tsIds.slice(i, i + ENTRY_CHUNK);
    const { data: chunk, error } = await sb
      .from("timesheet_entries")
      .select("id, timesheet_id, job_id, description, mon_hours, tue_hours, wed_hours, thu_hours, fri_hours, sat_hours, sun_hours")
      .in("timesheet_id", slice);
    if (error) throw error;
    flagTruncationRisk(chunk?.length, "Leave / Overtime report entries");
    if (chunk?.length) entries.push(...chunk);
  }

  if (!entries?.length) return rows;

  // Leave rows — one row per day with hours
  for (const entry of entries) {
    if (!leaveJobIds.has(entry.job_id)) continue;
    const ts = tsMap[entry.timesheet_id];
    if (!ts) continue;
    const emp = empMap[ts.user_id];
    if (!emp || !filteredEmpIds.has(emp.id)) continue;

    const job = jobMap[entry.job_id];
    const dept = emp.department_id ? deptMap[emp.department_id] : null;
    const wsDate = new Date(ts.week_start + "T00:00:00");

    for (let i = 0; i < 7; i++) {
      const h = Number(entry[`${DAYS[i]}_hours`]) || 0;
      if (h === 0) continue;
      const dayDate = addDays(wsDate, i);
      rows.push({
        employee: emp.name || "",
        employee_code: emp.employee_code || "",
        department: dept?.name || "",
        employment_type: emp.employment_type || "",
        date: fmtDate(dayDate),
        date_display: dayDate.toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" }),
        event: "Leave",
        event_detail: job?.job_code || "",
        event_description: job?.description || "",
        note: entry.description || "",
        hours: h,
      });
    }
  }

  // Overtime accumulation — worked hours only, leave entries excluded.
  // Leave is paid at OWP/AWE under NZ payroll convention and doesn't
  // contribute to the daily threshold that triggers OT.
  const empDayTotals = {};
  for (const entry of entries) {
    if (leaveJobIds.has(entry.job_id)) continue;
    const ts = tsMap[entry.timesheet_id];
    if (!ts) continue;
    if (!filteredEmpIds.has(ts.user_id)) continue;
    const key = `${ts.user_id}_${ts.week_start}`;
    if (!empDayTotals[key]) empDayTotals[key] = { userId: ts.user_id, wsDate: new Date(ts.week_start + "T00:00:00"), days: {} };
    for (let i = 0; i < 7; i++) {
      const h = Number(entry[`${DAYS[i]}_hours`]) || 0;
      empDayTotals[key].days[i] = (empDayTotals[key].days[i] || 0) + h;
    }
  }

  // Overtime rule (per PTL policy):
  //   1. Every worked hour on Saturday or Sunday is overtime, regardless
  //      of count. Weekend penalty rates apply.
  //   2. Any weekday with worked hours above the employee's daily
  //      threshold (default 8) is overtime for that day — one row per
  //      day with excess, attributed to that day.
  for (const { userId, wsDate, days } of Object.values(empDayTotals)) {
    const emp = empMap[userId];
    if (!emp) continue;
    // Skip employees flagged as not receiving overtime. Their hours
    // still log to the timesheet but they don't appear on the report.
    if (emp.receives_overtime === false) continue;
    const dept = emp.department_id ? deptMap[emp.department_id] : null;
    const dailyThreshold = Number(emp.overtime_daily_threshold_hours) || 8;

    // 1. Weekend hours → all OT, one row per weekend day with hours.
    for (const i of [5, 6]) {
      const h = days[i] || 0;
      if (h <= 0) continue;
      const dayDate = addDays(wsDate, i);
      rows.push({
        employee: emp.name || "",
        employee_code: emp.employee_code || "",
        department: dept?.name || "",
        employment_type: emp.employment_type || "",
        date: fmtDate(dayDate),
        date_display: dayDate.toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" }),
        event: "Overtime",
        event_detail: "OT",
        event_description: "Weekend hours",
        note: "",
        hours: Number(h.toFixed(2)),
      });
    }

    // 2. Per-weekday excess → one OT row per weekday that exceeded the
    //    daily threshold, attributed to that day.
    for (let i = 0; i < 5; i++) {
      const dailyExcess = Math.max(0, (days[i] || 0) - dailyThreshold);
      if (dailyExcess <= 0) continue;
      const dayDate = addDays(wsDate, i);
      rows.push({
        employee: emp.name || "",
        employee_code: emp.employee_code || "",
        department: dept?.name || "",
        employment_type: emp.employment_type || "",
        date: fmtDate(dayDate),
        date_display: dayDate.toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" }),
        event: "Overtime",
        event_detail: "OT",
        event_description: `Hours over ${dailyThreshold}/day`,
        note: "",
        hours: Number(dailyExcess.toFixed(2)),
      });
    }
  }

  return rows;
}

/* ---------- shared: sort + render ---------- */

// Per-view sort state. The waged and salaried tables render into different
// preview containers; sharing one set of globals meant clicking a header
// in one view rewrote the other view's sort and re-rendered it on the
// next show. Keyed by the previewId so it's stable across re-renders.
const lvSortStateByView = new Map();

function getLvSortState(previewId) {
  let s = lvSortStateByView.get(previewId);
  if (!s) {
    s = { col: "employee", asc: true };
    lvSortStateByView.set(previewId, s);
  }
  return s;
}

// Sort key for the Employee column: take everything after the first
// space as the surname. Per PTL convention, double first names are
// hyphenated ("Jean-Paul Smith") so the first-space split still finds
// the surname correctly. Also handles compound surnames ("Jean van
// Dyk" → "van Dyk") and suffixes ("John Smith Jr" → "Smith Jr") in
// the natural way.
function getSurname(name) {
  const parts = String(name || "").trim().split(/\s+/);
  if (parts.length <= 1) return parts[0] || "";
  return parts.slice(1).join(" ");
}

function sortLvRows(rows, previewId) {
  const { col, asc } = getLvSortState(previewId);
  const dir = asc ? 1 : -1;
  return [...rows].sort((a, b) => {
    let cmp = 0;
    const av = a[col], bv = b[col];
    if (col === "employee") {
      cmp = getSurname(av).localeCompare(getSurname(bv));
      if (cmp === 0) cmp = String(av || "").localeCompare(String(bv || ""));
    } else if (typeof av === "number" && typeof bv === "number") {
      cmp = av - bv;
    } else {
      cmp = String(av || "").localeCompare(String(bv || ""));
    }
    if (cmp !== 0) return cmp * dir;
    if (col !== "employee") {
      // Tiebreaker: still group rows for the same person together,
      // ordered by surname for consistency with the primary employee sort.
      cmp = getSurname(a.employee).localeCompare(getSurname(b.employee));
      if (cmp !== 0) return cmp;
      cmp = (a.employee || "").localeCompare(b.employee || "");
      if (cmp !== 0) return cmp;
    }
    return (a.date || "").localeCompare(b.date || "");
  });
}

function lvSortArrow(col, previewId) {
  const s = getLvSortState(previewId);
  if (s.col !== col) return "";
  return s.asc ? " &#9650;" : " &#9660;";
}

const LV_COLS = [
  { key: "employee",      label: "Employee" },
  { key: "employee_code", label: "Code" },
  { key: "department",    label: "Department" },
  { key: "date",          label: "Date" },
  { key: "event",         label: "Event" },
  { key: "event_detail",  label: "Detail" },
  { key: "note",          label: "Note" },
  { key: "hours",         label: "Hours" },
];

function renderLvRows(previewId, rows) {
  const preview = document.getElementById(previewId);
  const sorted = sortLvRows(rows, previewId);

  preview.innerHTML = `
    <table class="small lv-sortable">
      <thead>
        <tr>
          ${LV_COLS.map((c) => `<th class="${c.key === "hours" ? "num " : ""}lv-sort-hdr" data-col="${c.key}" style="cursor:pointer;user-select:none">${c.label}${lvSortArrow(c.key, previewId)}</th>`).join("")}
        </tr>
      </thead>
      <tbody>
        ${sorted.map((r) => `
          <tr class="${r.event === "Overtime" ? "lv-row-ot" : ""}">
            <td>${escapeHtml(r.employee)}</td>
            <td>${escapeHtml(r.employee_code)}</td>
            <td>${escapeHtml(r.department)}</td>
            <td class="nowrap">${escapeHtml(r.date_display)}</td>
            <td><strong>${escapeHtml(r.event)}</strong></td>
            <td>${escapeHtml(r.event_detail)}</td>
            <td>${escapeHtml(r.note)}</td>
            <td class="num"><strong>${fmtHours(r.hours)}</strong></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  preview.querySelectorAll(".lv-sort-hdr").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.col;
      const s = getLvSortState(previewId);
      if (s.col === col) s.asc = !s.asc;
      else { s.col = col; s.asc = true; }
      renderLvRows(previewId, rows);
    });
  });
}

async function lvExportToExcel(rows, filename, opts = {}) {
  const sorted = sortLvRows(rows, opts.previewId);
  const headers = ["Employee", "Employee Code", "Department", ...(opts.includeType ? ["Employment Type"] : []), "Date", "Event", "Detail", "Description", "Note", "Hours"];
  const wsData = [headers];
  for (const r of sorted) {
    wsData.push([r.employee, r.employee_code, r.department, ...(opts.includeType ? [r.employment_type] : []), r.date, r.event, r.event_detail, r.event_description, r.note, r.hours]);
  }
  const XLSX = await getXLSX();
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Leave Overtime");
  XLSX.writeFile(wb, filename);
}

// Printable leave/overtime report. Adds a "Logged" tick column so the admin
// can mark off each row as they enter it into payroll. Title and period
// label come from the caller so the same function serves waged-weekly and
// salaried-monthly views.
async function lvExportToPdf(rows, filename, { title, periodLabel, includeType, previewId }) {
  const sorted = sortLvRows(rows, previewId);
  const { jsPDF, autoTable } = await getPdf();
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const generatedAt = new Date().toLocaleString("en-NZ", {
    day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  });

  doc.setFontSize(16);
  doc.setFont(undefined, "bold");
  doc.text(title, 40, 40);
  doc.setFontSize(11);
  doc.setFont(undefined, "normal");
  doc.text(periodLabel, 40, 60);

  const leaveCount = sorted.filter((r) => r.event === "Leave").length;
  const otCount    = sorted.filter((r) => r.event === "Overtime").length;
  const totalHours = sorted.reduce((s, r) => s + Number(r.hours || 0), 0);
  const summary    = `${leaveCount} leave entries · ${otCount} overtime entries · ${fmtHours(totalHours)} total hours`;
  doc.setFontSize(10);
  doc.setTextColor(90);
  doc.text(summary, 40, 76);
  doc.setTextColor(0);

  // Column spec built as an array so the optional Employment Type column
  // (custom report) slots in without shifting hand-numbered style keys.
  const colSpec = [
    { title: "Logged", style: { cellWidth: 40, halign: "center" }, val: () => "" },
    { title: "Employee", style: { cellWidth: 110 }, val: (r) => r.employee || "" },
    { title: "Code", style: { cellWidth: 50 }, val: (r) => r.employee_code || "" },
    { title: "Department", style: { cellWidth: includeType ? 80 : 90 }, val: (r) => r.department || "" },
    ...(includeType ? [{ title: "Type", style: { cellWidth: 55 }, val: (r) => r.employment_type ? r.employment_type[0].toUpperCase() + r.employment_type.slice(1) : "" }] : []),
    { title: "Date", style: { cellWidth: 80 }, val: (r) => r.date_display || r.date || "" },
    { title: "Event", style: { cellWidth: 60 }, val: (r) => r.event || "" },
    { title: "Detail", style: { cellWidth: 50 }, val: (r) => r.event_detail || "" },
    { title: "Note", style: { cellWidth: "auto" }, val: (r) => r.note || "" },
    { title: "Hours", style: { cellWidth: 50, halign: "right", fontStyle: "bold" }, val: (r) => String(r.hours ?? "") },
  ];
  const head = [colSpec.map((c) => c.title)];
  const body = sorted.map((r) => colSpec.map((c) => c.val(r)));
  const columnStyles = {};
  colSpec.forEach((c, i) => { columnStyles[i] = c.style; });

  autoTable(doc, {
    head,
    body,
    startY: 92,
    margin: { left: 40, right: 40 },
    styles: { fontSize: 9, cellPadding: 4, lineColor: [220, 220, 220], lineWidth: 0.5 },
    headStyles: { fillColor: [190, 250, 64], textColor: [10, 10, 10], fontStyle: "bold" },
    alternateRowStyles: { fillColor: [248, 248, 248] },
    columnStyles,
    // Draw an empty square in the Logged column so admins can tick by hand
    // (printed copy) or via a PDF annotator (digital copy).
    didDrawCell: (data) => {
      if (data.section === "body" && data.column.index === 0) {
        const size = 10;
        const x = data.cell.x + (data.cell.width - size) / 2;
        const y = data.cell.y + (data.cell.height - size) / 2;
        doc.setDrawColor(120);
        doc.setLineWidth(0.7);
        doc.rect(x, y, size, size);
      }
    },
    didDrawPage: (data) => {
      const str = `Generated ${generatedAt} · Page ${doc.internal.getNumberOfPages()}`;
      doc.setFontSize(8);
      doc.setTextColor(140);
      doc.text(str, pageWidth - 40, doc.internal.pageSize.getHeight() - 20, { align: "right" });
      doc.setTextColor(0);
    },
  });

  doc.save(filename);
}

function lvSummaryText(rows) {
  const leaveCount = rows.filter((r) => r.event === "Leave").length;
  const otCount = rows.filter((r) => r.event === "Overtime").length;
  const parts = [];
  if (leaveCount) parts.push(`${leaveCount} leave`);
  if (otCount) parts.push(`${otCount} overtime`);
  return parts.length ? parts.join(", ") : "";
}

/* ---------- Waged (weekly) ---------- */

let lvWeek = new Date(thisMonday);
let lvWagedRows = [];

function updateLvWeekLabel() {
  const end = addDays(lvWeek, 6);
  document.getElementById("lv-week-label").textContent =
    `${lvWeek.toLocaleDateString("en-NZ", { month: "short", day: "numeric" })} — ${end.toLocaleDateString("en-NZ", { month: "short", day: "numeric", year: "numeric" })}`;
}
updateLvWeekLabel();

document.getElementById("lv-prev").addEventListener("click", () => { lvWeek = addDays(lvWeek, -7); updateLvWeekLabel(); loadWagedReport(); });
document.getElementById("lv-next").addEventListener("click", () => { lvWeek = addDays(lvWeek, 7); updateLvWeekLabel(); loadWagedReport(); });
document.getElementById("lv-include-drafts")?.addEventListener("change", () => loadWagedReport());

async function loadWagedReport() {
  const preview = document.getElementById("lv-preview");
  const summary = document.getElementById("lv-summary");
  preview.innerHTML = skeletonBlock();

  try {
    lvWagedRows = await buildLeaveRowsForWeeks([fmtDate(lvWeek)], "waged", document.getElementById("lv-include-drafts").checked);
    summary.textContent = lvSummaryText(lvWagedRows);

    if (!lvWagedRows.length) {
      preview.innerHTML = `<p class="muted small" style="text-align:center">No leave or overtime entries found for waged employees this week.</p>`;
      return;
    }
    renderLvRows("lv-preview", lvWagedRows);
  } catch (err) {
    preview.innerHTML = `<p class="muted small" style="text-align:center">Error: ${escapeHtml(err.message)}</p>`;
  }
}

document.getElementById("lv-export-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("lv-status");
  statusEl.textContent = "Generating…";
  try {
    if (!lvWagedRows.length) lvWagedRows = await buildLeaveRowsForWeeks([fmtDate(lvWeek)], "waged", document.getElementById("lv-include-drafts").checked);
    if (!lvWagedRows.length) { notice("No data to export", "warn"); statusEl.textContent = ""; return; }
    await lvExportToExcel(lvWagedRows, `leave-overtime-waged-${fmtDate(lvWeek)}.xlsx`);
    statusEl.textContent = "Done";
    notice(`Exported ${lvWagedRows.length} entries`, "success");
    setTimeout(() => statusEl.textContent = "", 3000);
  } catch (err) { notice(err.message || "Export failed", "error"); statusEl.textContent = ""; }
});

document.getElementById("lv-export-pdf-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("lv-status");
  statusEl.textContent = "Generating…";
  try {
    if (!lvWagedRows.length) lvWagedRows = await buildLeaveRowsForWeeks([fmtDate(lvWeek)], "waged", document.getElementById("lv-include-drafts").checked);
    if (!lvWagedRows.length) { notice("No data to export", "warn"); statusEl.textContent = ""; return; }
    const end = addDays(lvWeek, 6);
    const periodLabel = `Week ${lvWeek.toLocaleDateString("en-NZ", { day: "numeric", month: "short" })} — ${end.toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" })}`;
    await lvExportToPdf(lvWagedRows, `leave-overtime-waged-${fmtDate(lvWeek)}.pdf`, {
      title: "PTL — Leave / Overtime Report (Waged)",
      periodLabel,
    });
    statusEl.textContent = "Done";
    notice(`Exported ${lvWagedRows.length} entries`, "success");
    setTimeout(() => statusEl.textContent = "", 3000);
  } catch (err) { notice(err.message || "Export failed", "error"); statusEl.textContent = ""; }
});

/* ---------- Salaried (monthly) ---------- */

let lvMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let lvSalariedRows = [];

function updateLvMonthLabel() {
  document.getElementById("lv-month-label").textContent =
    lvMonth.toLocaleDateString("en-NZ", { month: "long", year: "numeric" });
}
updateLvMonthLabel();

document.getElementById("lv-month-prev").addEventListener("click", () => { lvMonth = new Date(lvMonth.getFullYear(), lvMonth.getMonth() - 1, 1); updateLvMonthLabel(); loadSalariedReport(); });
document.getElementById("lv-month-next").addEventListener("click", () => { lvMonth = new Date(lvMonth.getFullYear(), lvMonth.getMonth() + 1, 1); updateLvMonthLabel(); loadSalariedReport(); });
document.getElementById("lv-sal-include-drafts")?.addEventListener("change", () => loadSalariedReport());

function getMondaysInMonth(year, month) {
  const mondays = [];
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  let d = getMonday(first);
  while (d <= last) {
    mondays.push(fmtDate(d));
    d = addDays(d, 7);
  }
  return mondays;
}

async function loadSalariedReport() {
  const preview = document.getElementById("lv-sal-preview");
  const summary = document.getElementById("lv-sal-summary");
  preview.innerHTML = skeletonBlock();

  try {
    const weeks = getMondaysInMonth(lvMonth.getFullYear(), lvMonth.getMonth());
    lvSalariedRows = await buildLeaveRowsForWeeks(weeks, "salaried", document.getElementById("lv-sal-include-drafts").checked);
    summary.textContent = lvSummaryText(lvSalariedRows);

    if (!lvSalariedRows.length) {
      preview.innerHTML = `<p class="muted small" style="text-align:center">No leave or overtime entries found for salaried employees this month.</p>`;
      return;
    }
    renderLvRows("lv-sal-preview", lvSalariedRows);
  } catch (err) {
    preview.innerHTML = `<p class="muted small" style="text-align:center">Error: ${escapeHtml(err.message)}</p>`;
  }
}

document.getElementById("lv-sal-export-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("lv-sal-status");
  statusEl.textContent = "Generating…";
  try {
    if (!lvSalariedRows.length) {
      const weeks = getMondaysInMonth(lvMonth.getFullYear(), lvMonth.getMonth());
      lvSalariedRows = await buildLeaveRowsForWeeks(weeks, "salaried", document.getElementById("lv-sal-include-drafts").checked);
    }
    if (!lvSalariedRows.length) { notice("No data to export", "warn"); statusEl.textContent = ""; return; }
    const monthStr = `${lvMonth.getFullYear()}-${String(lvMonth.getMonth() + 1).padStart(2, "0")}`;
    await lvExportToExcel(lvSalariedRows, `leave-overtime-salaried-${monthStr}.xlsx`);
    statusEl.textContent = "Done";
    notice(`Exported ${lvSalariedRows.length} entries`, "success");
    setTimeout(() => statusEl.textContent = "", 3000);
  } catch (err) { notice(err.message || "Export failed", "error"); statusEl.textContent = ""; }
});

document.getElementById("lv-sal-export-pdf-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("lv-sal-status");
  statusEl.textContent = "Generating…";
  try {
    if (!lvSalariedRows.length) {
      const weeks = getMondaysInMonth(lvMonth.getFullYear(), lvMonth.getMonth());
      lvSalariedRows = await buildLeaveRowsForWeeks(weeks, "salaried", document.getElementById("lv-sal-include-drafts").checked);
    }
    if (!lvSalariedRows.length) { notice("No data to export", "warn"); statusEl.textContent = ""; return; }
    const monthStr = `${lvMonth.getFullYear()}-${String(lvMonth.getMonth() + 1).padStart(2, "0")}`;
    const periodLabel = lvMonth.toLocaleDateString("en-NZ", { month: "long", year: "numeric" });
    await lvExportToPdf(lvSalariedRows, `leave-overtime-salaried-${monthStr}.pdf`, {
      title: "PTL — Leave / Overtime Report (Salaried)",
      periodLabel,
    });
    statusEl.textContent = "Done";
    notice(`Exported ${lvSalariedRows.length} entries`, "success");
    setTimeout(() => statusEl.textContent = "", 3000);
  } catch (err) { notice(err.message || "Export failed", "error"); statusEl.textContent = ""; }
});

/* ---------- Custom report (Excel-style column filters) ---------- */

// All leave + overtime rows over an arbitrary date range, filterable per
// column like the Orders-page filters in the ERP: clicking a header opens
// a menu with two sort options, a Clear link, and a filter whose type
// matches the column (checkbox list, contains box, min/max, or a
// year → month → day date tree). Filters combine across columns, apply
// instantly, and the totals tiles + exports follow the filtered set.
// The dataset is fetched once per range and filtered client-side — at
// PTL's scale (~70 staff) that's a few thousand rows at most.

let lvCustomRaw = [];
let lvCustomLoaded = false;
let lvcRangeFrom = null;
let lvcRangeTo = null;

const LVC_COLS = [
  { key: "employee",        label: "Employee",   type: "list" },
  { key: "employee_code",   label: "Code",       type: "text" },
  { key: "department",      label: "Department", type: "list" },
  { key: "employment_type", label: "Type",       type: "list" },
  { key: "date",            label: "Date",       type: "date",   sortA: "Sort oldest first",   sortD: "Sort newest first" },
  { key: "event",           label: "Event",      type: "list" },
  { key: "event_detail",    label: "Detail",     type: "list" },
  { key: "note",            label: "Note",       type: "text" },
  { key: "hours",           label: "Hours",      type: "number", sortA: "Sort smallest first", sortD: "Sort largest first" },
];

// Selected values per column. Empty set / blank text / null bounds = no
// filter on that column.
const lvcSel = { employee: new Set(), department: new Set(), employment_type: new Set(), event: new Set(), event_detail: new Set(), date: new Set() };
const lvcText = { employee_code: "", note: "" };
const lvcNum = { hours: { min: null, max: null } };
// Which years/months are expanded in the date tree ("2026", "2026-07").
const lvcDateExpand = new Set();

function lvcTypeLabel(v) {
  return v ? v[0].toUpperCase() + v.slice(1) : "(blank)";
}

function lvcFilterCount(col) {
  if (col.type === "list" || col.type === "date") return lvcSel[col.key].size;
  if (col.type === "text") return lvcText[col.key].trim() ? 1 : 0;
  if (col.type === "number") {
    const { min, max } = lvcNum[col.key];
    return (min != null ? 1 : 0) + (max != null ? 1 : 0);
  }
  return 0;
}

function lvcFilteredRows() {
  return lvCustomRaw.filter((r) => {
    for (const key of Object.keys(lvcSel)) {
      const sel = lvcSel[key];
      if (sel.size && !sel.has(String(r[key] ?? ""))) return false;
    }
    for (const key of Object.keys(lvcText)) {
      const q = lvcText[key].trim().toLowerCase();
      if (q && !String(r[key] || "").toLowerCase().includes(q)) return false;
    }
    const { min, max } = lvcNum.hours;
    if (min != null && !(Number(r.hours) >= min)) return false;
    if (max != null && !(Number(r.hours) <= max)) return false;
    return true;
  });
}

function renderLvcTiles(rows) {
  const el = document.getElementById("lv-cust-tiles");
  if (!el) return;
  const sum = (a) => a.reduce((s, r) => s + Number(r.hours || 0), 0);
  const leave = rows.filter((r) => r.event === "Leave");
  const ot = rows.filter((r) => r.event === "Overtime");
  const tile = (num, lbl) => `<div class="tile"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`;
  el.innerHTML =
    tile(rows.length, "Entries") +
    tile(fmtHours(sum(leave)), "Leave hours") +
    tile(fmtHours(sum(ot)), "Overtime hours") +
    tile(fmtHours(sum(rows)), "Total hours");
}

function lvcRender() {
  const preview = document.getElementById("lv-cust-preview");
  if (!preview || !lvCustomLoaded) return;
  const rows = sortLvRows(lvcFilteredRows(), "lv-cust-preview");

  const ths = LVC_COLS.map((c) => {
    const n = lvcFilterCount(c);
    const badge = n ? ` <span class="lv-hdr-badge">· ${n}</span>` : "";
    return `<th class="${c.key === "hours" ? "num " : ""}lvc-hdr" data-col="${c.key}" style="cursor:pointer;user-select:none;white-space:nowrap" title="Sort / filter">${c.label}${badge}${lvSortArrow(c.key, "lv-cust-preview")}</th>`;
  }).join("");

  // Filtered-to-empty still renders the header row so a menu can be
  // reopened to clear the filter.
  const bodyHtml = rows.length
    ? rows.map((r) => `
        <tr class="${r.event === "Overtime" ? "lv-row-ot" : ""}">
          <td>${escapeHtml(r.employee)}</td>
          <td>${escapeHtml(r.employee_code)}</td>
          <td>${escapeHtml(r.department)}</td>
          <td>${escapeHtml(r.employment_type ? lvcTypeLabel(r.employment_type) : "")}</td>
          <td class="nowrap">${escapeHtml(r.date_display)}</td>
          <td><strong>${escapeHtml(r.event)}</strong></td>
          <td>${escapeHtml(r.event_detail)}</td>
          <td>${escapeHtml(r.note)}</td>
          <td class="num"><strong>${fmtHours(r.hours)}</strong></td>
        </tr>`).join("")
    : `<tr><td colspan="${LVC_COLS.length}" class="muted small" style="text-align:center;padding:16px">No rows match the current filters.</td></tr>`;

  preview.innerHTML = `
    <table class="small lv-sortable">
      <thead><tr>${ths}</tr></thead>
      <tbody>${bodyHtml}</tbody>
    </table>`;

  preview.querySelectorAll(".lvc-hdr").forEach((th) => {
    th.addEventListener("click", () => openLvcMenu(th.dataset.col, th));
  });

  renderLvcTiles(rows);
}

/* ----- the filter menu ----- */

let lvcMenu = null;
let lvcMenuCol = null;

function closeLvcMenu() {
  if (lvcMenu) { lvcMenu.remove(); lvcMenu = null; lvcMenuCol = null; }
}

// Outside click / Escape closes the menu. Clicks inside keep it open so a
// multi-value selection can be built up.
document.addEventListener("pointerdown", (e) => {
  if (lvcMenu && !lvcMenu.contains(e.target) && !e.target.closest(".lvc-hdr")) closeLvcMenu();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLvcMenu(); });

function lvcDebounce(fn, ms = 250) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function openLvcMenu(colKey, th) {
  if (lvcMenuCol === colKey) { closeLvcMenu(); return; }
  closeLvcMenu();
  const col = LVC_COLS.find((c) => c.key === colKey);
  if (!col) return;

  const menu = document.createElement("div");
  menu.className = "lv-filter-menu";

  const sortA = col.sortA || "Sort A → Z";
  const sortD = col.sortD || "Sort Z → A";
  const head = document.createElement("div");
  head.innerHTML = `
    <button type="button" class="lvm-sort" data-dir="asc">${sortA}</button>
    <button type="button" class="lvm-sort" data-dir="desc">${sortD}</button>
    <hr />
    <div class="lvm-head">
      <strong class="small">${col.label}</strong>
      <a href="#" class="small lvm-clear">Clear</a>
    </div>`;
  menu.appendChild(head);

  head.querySelectorAll(".lvm-sort").forEach((b) => {
    b.addEventListener("click", () => {
      const s = getLvSortState("lv-cust-preview");
      s.col = colKey;
      s.asc = b.dataset.dir === "asc";
      closeLvcMenu();   // picking a sort closes the menu, like Excel
      lvcRender();
    });
  });
  head.querySelector(".lvm-clear").addEventListener("click", (e) => {
    e.preventDefault();
    if (col.type === "list" || col.type === "date") lvcSel[colKey].clear();
    else if (col.type === "text") lvcText[colKey] = "";
    else if (col.type === "number") lvcNum[colKey] = { min: null, max: null };
    lvcRender();
    // Rebuild the menu body so its controls reflect the cleared state.
    const reopenTh = document.querySelector(`.lvc-hdr[data-col="${colKey}"]`);
    if (reopenTh) { lvcMenuCol = null; openLvcMenu(colKey, reopenTh); }
  });

  const bodyEl = document.createElement("div");
  menu.appendChild(bodyEl);
  if (col.type === "list") lvcBuildListBody(bodyEl, col);
  else if (col.type === "text") lvcBuildTextBody(bodyEl, col);
  else if (col.type === "number") lvcBuildNumberBody(bodyEl, col);
  else if (col.type === "date") lvcBuildDateBody(bodyEl);

  document.body.appendChild(menu);
  lvcMenu = menu;
  lvcMenuCol = colKey;

  // Fixed positioning under the clicked header, clamped to the viewport.
  const rect = th.getBoundingClientRect();
  const width = col.type === "date" ? 300 : 270;
  menu.style.width = width + "px";
  menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + "px";
  const top = rect.bottom + 4;
  menu.style.top = top + "px";
  menu.style.maxHeight = Math.max(180, window.innerHeight - top - 12) + "px";
}

// Checkbox list of the values that actually exist in the loaded data,
// with row counts and (when long) a search box. Employees are labelled
// "Name (CODE)" like the ERP's Officer filter.
function lvcBuildListBody(bodyEl, col) {
  const counts = new Map();
  const codeByEmployee = new Map();
  for (const r of lvCustomRaw) {
    const v = String(r[col.key] ?? "");
    counts.set(v, (counts.get(v) || 0) + 1);
    if (col.key === "employee" && r.employee_code) codeByEmployee.set(v, r.employee_code);
  }
  const values = [...counts.keys()].sort((a, b) => a.localeCompare(b));
  const display = (v) => {
    if (!v) return "(blank)";
    if (col.key === "employee" && codeByEmployee.get(v)) return `${v} (${codeByEmployee.get(v)})`;
    if (col.key === "employment_type") return lvcTypeLabel(v);
    return v;
  };

  const listEl = document.createElement("div");
  listEl.className = "lvm-list";

  const renderItems = (filterText) => {
    const q = (filterText || "").toLowerCase();
    listEl.innerHTML = values
      .filter((v) => !q || display(v).toLowerCase().includes(q))
      .map((v) => `
        <label class="lvm-item">
          <input type="checkbox" data-val="${escapeHtml(v)}" ${lvcSel[col.key].has(v) ? "checked" : ""} />
          <span class="grow">${escapeHtml(display(v))}</span>
          <span class="muted small">${counts.get(v)}</span>
        </label>`).join("") || `<div class="muted small" style="padding:8px">No matches</div>`;
    listEl.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const val = cb.dataset.val;
        if (cb.checked) lvcSel[col.key].add(val);
        else lvcSel[col.key].delete(val);
        lvcRender();   // menu stays open — keep building the selection
      });
    });
  };

  if (values.length > 8) {
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Search…";
    search.className = "lvm-search";
    search.addEventListener("input", () => renderItems(search.value));
    bodyEl.appendChild(search);
  }
  bodyEl.appendChild(listEl);
  renderItems("");
}

function lvcBuildTextBody(bodyEl, col) {
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "Contains…";
  input.className = "lvm-search";
  input.value = lvcText[col.key];
  input.addEventListener("input", lvcDebounce(() => {
    lvcText[col.key] = input.value;
    lvcRender();   // input lives in the menu, so focus survives the table re-render
  }));
  bodyEl.appendChild(input);
}

function lvcBuildNumberBody(bodyEl, col) {
  bodyEl.innerHTML = `
    <div class="row-flex" style="gap:8px;padding:4px 8px 8px">
      <div class="grow"><label class="small muted">Min</label>
        <input type="number" step="0.25" class="lvm-num" data-bound="min" style="width:100%" value="${lvcNum[col.key].min ?? ""}"></div>
      <div class="grow"><label class="small muted">Max</label>
        <input type="number" step="0.25" class="lvm-num" data-bound="max" style="width:100%" value="${lvcNum[col.key].max ?? ""}"></div>
    </div>`;
  bodyEl.querySelectorAll(".lvm-num").forEach((input) => {
    input.addEventListener("input", lvcDebounce(() => {
      const v = input.value === "" ? null : Number(input.value);
      lvcNum[col.key][input.dataset.bound] = Number.isFinite(v) ? v : null;
      lvcRender();
    }));
  });
}

/* ----- date tree: year → month → day, covering EVERY day in the loaded
   range (not just days that have entries), per the spec ----- */

function lvcAllDates() {
  const out = [];
  if (!lvcRangeFrom || !lvcRangeTo) return out;
  let d = new Date(lvcRangeFrom + "T00:00:00");
  const end = new Date(lvcRangeTo + "T00:00:00");
  while (d <= end) { out.push(fmtDate(d)); d = addDays(d, 1); }
  return out;
}

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function lvcBuildDateBody(bodyEl) {
  const treeEl = document.createElement("div");
  treeEl.className = "lvm-list lvm-tree";
  bodyEl.appendChild(treeEl);

  // years → months → days, from the full range.
  const tree = new Map();  // "2026" → Map("2026-07" → ["2026-07-01", …])
  for (const iso of lvcAllDates()) {
    const y = iso.slice(0, 4), ym = iso.slice(0, 7);
    if (!tree.has(y)) tree.set(y, new Map());
    const months = tree.get(y);
    if (!months.has(ym)) months.set(ym, []);
    months.get(ym).push(iso);
  }
  // Years expanded by default so the months are immediately visible.
  for (const y of tree.keys()) lvcDateExpand.add(y);

  const sel = lvcSel.date;
  const stateOf = (dates) => {
    let on = 0;
    for (const d of dates) if (sel.has(d)) on++;
    return on === 0 ? "none" : on === dates.length ? "all" : "some";
  };

  const renderTree = () => {
    const scroll = treeEl.scrollTop;
    let html = "";
    for (const [y, months] of tree) {
      const yDates = [...months.values()].flat();
      const yState = stateOf(yDates);
      const yOpen = lvcDateExpand.has(y);
      html += `
        <div class="lvm-tree-row">
          <span class="lvm-expander" data-node="${y}">${yOpen ? "▾" : "▸"}</span>
          <label class="lvm-item grow" style="padding:2px 4px">
            <input type="checkbox" data-dates="${y}" ${yState === "all" ? "checked" : ""} data-ind="${yState === "some"}" />
            <span class="grow"><strong>${y}</strong></span>
          </label>
        </div>`;
      if (!yOpen) continue;
      for (const [ym, dates] of months) {
        const mState = stateOf(dates);
        const mOpen = lvcDateExpand.has(ym);
        const mName = MONTH_NAMES[Number(ym.slice(5, 7)) - 1];
        html += `
          <div class="lvm-tree-row" style="padding-left:20px">
            <span class="lvm-expander" data-node="${ym}">${mOpen ? "▾" : "▸"}</span>
            <label class="lvm-item grow" style="padding:2px 4px">
              <input type="checkbox" data-dates="${ym}" ${mState === "all" ? "checked" : ""} data-ind="${mState === "some"}" />
              <span class="grow">${mName}</span>
            </label>
          </div>`;
        if (mOpen) {
          html += `<div class="lvm-days">` + dates.map((iso) =>
            `<button type="button" class="lv-day-chip ${sel.has(iso) ? "on" : ""}" data-date="${iso}">${Number(iso.slice(8, 10))}</button>`
          ).join("") + `</div>`;
        }
      }
    }
    treeEl.innerHTML = html;
    treeEl.scrollTop = scroll;

    treeEl.querySelectorAll("input[data-ind=true]").forEach((cb) => { cb.indeterminate = true; });

    treeEl.querySelectorAll(".lvm-expander").forEach((ex) => {
      ex.addEventListener("click", () => {
        const node = ex.dataset.node;
        if (lvcDateExpand.has(node)) lvcDateExpand.delete(node);
        else lvcDateExpand.add(node);
        renderTree();
      });
    });

    treeEl.querySelectorAll("input[data-dates]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const prefix = cb.dataset.dates;
        const dates = prefix.length === 4
          ? [...(tree.get(prefix)?.values() || [])].flat()
          : tree.get(prefix.slice(0, 4))?.get(prefix) || [];
        if (cb.checked) dates.forEach((d) => sel.add(d));
        else dates.forEach((d) => sel.delete(d));
        renderTree();   // refresh tri-states
        lvcRender();
      });
    });

    treeEl.querySelectorAll(".lv-day-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const iso = chip.dataset.date;
        if (sel.has(iso)) sel.delete(iso);
        else sel.add(iso);
        renderTree();
        lvcRender();
      });
    });
  };

  renderTree();
}

/* ----- data load + wiring ----- */

async function loadCustomReport() {
  const fromEl = document.getElementById("lv-cust-from");
  const toEl = document.getElementById("lv-cust-to");
  const preview = document.getElementById("lv-cust-preview");
  const from = fromEl.value, to = toEl.value;
  if (!from || !to) return notice("Pick both From and To dates", "warn");
  if (to < from) return notice("The To date is before the From date", "warn");

  closeLvcMenu();
  preview.innerHTML = skeletonBlock();
  try {
    // Every Monday whose week overlaps the range. Fetched in small chunks
    // of weeks so no single timesheets/entries query nears Supabase's
    // 1000-row cap (which truncates silently).
    const mondays = [];
    let m = getMonday(new Date(from + "T00:00:00"));
    const endD = new Date(to + "T00:00:00");
    while (m <= endD) { mondays.push(fmtDate(m)); m = addDays(m, 7); }

    const drafts = document.getElementById("lv-cust-include-drafts").checked;
    const all = [];
    const WEEK_CHUNK = 6;
    for (let i = 0; i < mondays.length; i += WEEK_CHUNK) {
      all.push(...await buildLeaveRowsForWeeks(mondays.slice(i, i + WEEK_CHUNK), null, drafts));
    }
    // Weeks overhang the range at both ends — clip to the exact days.
    lvCustomRaw = all.filter((r) => r.date >= from && r.date <= to);
    lvcRangeFrom = from;
    lvcRangeTo = to;
    // Drop date selections that fell outside the new range.
    for (const d of [...lvcSel.date]) if (d < from || d > to) lvcSel.date.delete(d);
    lvCustomLoaded = true;
    lvcRender();
  } catch (err) {
    preview.innerHTML = `<p class="muted small" style="text-align:center;color:#c00">${escapeHtml(err.message || "Load failed")}</p>`;
  }
}

// Defaults: start of the current year through today.
{
  const today = new Date();
  const fromEl = document.getElementById("lv-cust-from");
  const toEl = document.getElementById("lv-cust-to");
  if (fromEl && toEl) {
    fromEl.value = `${today.getFullYear()}-01-01`;
    toEl.value = fmtDate(today);
  }
}

document.getElementById("lv-cust-load")?.addEventListener("click", loadCustomReport);
document.getElementById("lv-cust-include-drafts")?.addEventListener("change", () => { if (lvCustomLoaded) loadCustomReport(); });

document.getElementById("lv-cust-clear")?.addEventListener("click", () => {
  for (const k of Object.keys(lvcSel)) lvcSel[k].clear();
  for (const k of Object.keys(lvcText)) lvcText[k] = "";
  lvcNum.hours = { min: null, max: null };
  closeLvcMenu();
  lvcRender();
});

document.getElementById("lv-cust-export-btn")?.addEventListener("click", async () => {
  const statusEl = document.getElementById("lv-cust-status");
  statusEl.textContent = "Generating…";
  try {
    if (!lvCustomLoaded) await loadCustomReport();
    const rows = lvcFilteredRows();
    await lvExportToExcel(rows, `leave-overtime-custom-${lvcRangeFrom}-to-${lvcRangeTo}.xlsx`, { includeType: true, previewId: "lv-cust-preview" });
    statusEl.textContent = "Done";
    notice(`Exported ${rows.length} entries`, "success");
    setTimeout(() => statusEl.textContent = "", 3000);
  } catch (err) { notice(err.message || "Export failed", "error"); statusEl.textContent = ""; }
});

document.getElementById("lv-cust-export-pdf-btn")?.addEventListener("click", async () => {
  const statusEl = document.getElementById("lv-cust-status");
  statusEl.textContent = "Generating…";
  try {
    if (!lvCustomLoaded) await loadCustomReport();
    const rows = lvcFilteredRows();
    await lvExportToPdf(rows, `leave-overtime-custom-${lvcRangeFrom}-to-${lvcRangeTo}.pdf`, {
      title: "PTL — Leave / Overtime Report (Custom)",
      periodLabel: `${lvcRangeFrom} → ${lvcRangeTo}`,
      includeType: true,
      previewId: "lv-cust-preview",
    });
    statusEl.textContent = "Done";
    notice(`Exported ${rows.length} entries`, "success");
    setTimeout(() => statusEl.textContent = "", 3000);
  } catch (err) { notice(err.message || "Export failed", "error"); statusEl.textContent = ""; }
});

/* ================================================================
 * Dev Tools — Generate Test Timesheets
 * ================================================================ */

let devToolsLoaded = false;

async function loadDevToolsForm() {
  if (devToolsLoaded) return;
  devToolsLoaded = true;

  const { data: depts } = await sb
    .from("departments")
    .select("id, name, is_overhead")
    .eq("organisation_id", currentOrgId)
    .eq("active", true)
    .order("name");

  const sel = document.getElementById("gen-dept");
  sel.innerHTML = (depts || [])
    .filter((d) => !d.is_overhead)
    .map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`)
    .join("");

  const monday = getActiveMonday();
  document.getElementById("gen-week").value = fmtDate(monday);
}

document.getElementById("reset-hours-btn")?.addEventListener("click", async () => {
  if (!currentOrgId) return notice("No org selected", "warn");
  const btn = document.getElementById("reset-hours-btn");
  const msg = document.getElementById("reset-hours-msg");

  // Two-stage confirm: a generic confirm, then a type-the-word gate.
  if (!await confirmDialog({
    title: "Reset all hours?",
    message: "This deletes every timesheet and entry in this organisation. Real timesheets will be wiped too. There is no undo.",
    confirmText: "Continue",
  })) return;
  const typed = prompt('Type "RESET" to confirm:');
  if (typed !== "RESET") return notice("Cancelled", "info");

  btn.disabled = true;
  msg.textContent = "Resetting…";
  try {
    const { data, error } = await sb.rpc("reset_org_hours", { p_org_id: currentOrgId });
    if (error) throw error;
    invalidateWeekDashboard(currentOrgId);
    notice(`Deleted ${data ?? 0} timesheet${data === 1 ? "" : "s"} and all their entries`, "success");
    msg.textContent = "Done";
    setTimeout(() => { msg.textContent = ""; }, 4000);
  } catch (err) {
    notice(err.message || "Reset failed", "error");
    msg.textContent = "";
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("gen-timesheets-btn")?.addEventListener("click", async () => {
  const deptId = Number(document.getElementById("gen-dept").value);
  const weekStr = document.getElementById("gen-week").value;
  const targetStatus = document.getElementById("gen-status").value;
  const statusMsg = document.getElementById("gen-status-msg");
  const resultsEl = document.getElementById("gen-results");

  if (!deptId || !weekStr) return notice("Select a department and week", "warn");

  const btn = document.getElementById("gen-timesheets-btn");
  btn.disabled = true;
  statusMsg.textContent = "Loading data…";
  resultsEl.style.display = "none";

  try {
    const [empRes, jobRes, taskRes, dcRes] = await Promise.all([
      sb.from("users").select("id, name").eq("organisation_id", currentOrgId).eq("department_id", deptId).eq("active", true),
      sb.from("jobs").select("id, job_code, status, is_leave, leave_type_id").eq("organisation_id", currentOrgId),
      sb.from("tasks").select("id, task_code").eq("organisation_id", currentOrgId).eq("status", "ACTIVE"),
      sb.from("department_codes").select("id, code").eq("organisation_id", currentOrgId).eq("status", "ACTIVE"),
    ]);

    const employees = empRes.data || [];
    const allJobs = jobRes.data || [];
    const tasks = taskRes.data || [];
    const deptCodes = dcRes.data || [];

    if (!employees.length) {
      statusMsg.textContent = "";
      btn.disabled = false;
      return notice("No active employees in this department", "warn");
    }

    const regularJobs = allJobs.filter((j) => !j.is_leave && j.status === "ACTIVE");
    const nonActiveJobs = allJobs.filter((j) => !j.is_leave && j.status !== "ACTIVE");
    const leaveJobs = allJobs.filter((j) => j.is_leave);

    if (!regularJobs.length) {
      statusMsg.textContent = "";
      btn.disabled = false;
      return notice("No active jobs found — add some jobs first", "warn");
    }

    function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
    function randBetween(min, max) { return Math.round((min + Math.random() * (max - min)) * 4) / 4; }

    const results = [];
    let created = 0;

    for (const emp of employees) {
      statusMsg.textContent = `Generating for ${emp.name}…`;

      // Create or get timesheet
      const { data: tsId, error: tsErr } = await sb.rpc("get_or_create_timesheet", {
        p_week_start: weekStr,
        p_user_id: emp.id,
      });

      let timesheetId = tsId;

      if (tsErr) {
        // RPC may not accept p_user_id — insert directly
        const { data: existing } = await sb
          .from("timesheets")
          .select("id")
          .eq("user_id", emp.id)
          .eq("week_start", weekStr)
          .maybeSingle();

        if (existing) {
          timesheetId = existing.id;
        } else {
          const { data: newTs, error: insErr } = await sb
            .from("timesheets")
            .insert({ organisation_id: currentOrgId, user_id: emp.id, week_start: weekStr, status: "draft" })
            .select("id")
            .single();
          if (insErr) { results.push({ name: emp.name, error: insErr.message }); continue; }
          timesheetId = newTs.id;
        }
      }

      // Clear any existing entries
      await sb.from("timesheet_entries").delete().eq("timesheet_id", timesheetId);

      // Decide how many regular job entries (2-4)
      const numRegular = 2 + Math.floor(Math.random() * 3);
      // Maybe add a leave entry (30% chance)
      const hasLeave = leaveJobs.length > 0 && Math.random() < 0.3;
      // Maybe add overtime on 1-2 days (20% chance)
      const hasOvertime = Math.random() < 0.2;
      // 10% chance of a non-active job
      const hasNonActive = nonActiveJobs.length > 0 && Math.random() < 0.1;

      const entries = [];
      let sortOrder = 0;

      // Regular job entries
      const usedJobs = new Set();
      for (let i = 0; i < numRegular; i++) {
        let job;
        let attempts = 0;
        do { job = pick(regularJobs); attempts++; } while (usedJobs.has(job.id) && attempts < 20);
        usedJobs.add(job.id);

        const hours = { mon_hours: 0, tue_hours: 0, wed_hours: 0, thu_hours: 0, fri_hours: 0, sat_hours: 0, sun_hours: 0 };
        const dayKeys = ["mon_hours", "tue_hours", "wed_hours", "thu_hours", "fri_hours"];

        for (const day of dayKeys) {
          if (Math.random() < 0.7) {
            hours[day] = randBetween(1, 4);
          }
        }

        entries.push({
          timesheet_id: timesheetId,
          job_id: job.id,
          task_id: tasks.length ? pick(tasks).id : null,
          dept_code_id: deptCodes.length ? pick(deptCodes).id : null,
          description: "",
          sort_order: sortOrder++,
          ...hours,
        });
      }

      // Non-active job entry
      if (hasNonActive) {
        const job = pick(nonActiveJobs);
        const hours = { mon_hours: 0, tue_hours: 0, wed_hours: 0, thu_hours: 0, fri_hours: 0, sat_hours: 0, sun_hours: 0 };
        const day = pick(["mon_hours", "tue_hours", "wed_hours", "thu_hours", "fri_hours"]);
        hours[day] = randBetween(1, 3);
        entries.push({
          timesheet_id: timesheetId,
          job_id: job.id,
          task_id: tasks.length ? pick(tasks).id : null,
          dept_code_id: deptCodes.length ? pick(deptCodes).id : null,
          description: "",
          sort_order: sortOrder++,
          ...hours,
        });
      }

      // Leave entry
      if (hasLeave) {
        const leaveJob = pick(leaveJobs);
        const hours = { mon_hours: 0, tue_hours: 0, wed_hours: 0, thu_hours: 0, fri_hours: 0, sat_hours: 0, sun_hours: 0 };
        // 1-2 days of leave
        const leaveDays = 1 + Math.floor(Math.random() * 2);
        const possibleDays = ["mon_hours", "tue_hours", "wed_hours", "thu_hours", "fri_hours"];
        for (let i = 0; i < leaveDays && possibleDays.length; i++) {
          const idx = Math.floor(Math.random() * possibleDays.length);
          hours[possibleDays.splice(idx, 1)[0]] = 8;
        }
        entries.push({
          timesheet_id: timesheetId,
          job_id: leaveJob.id,
          task_id: null,
          dept_code_id: null,
          description: "",
          sort_order: sortOrder++,
          ...hours,
        });
      }

      // Normalize so daily totals are around 8h (with slight variance)
      const dayKeys = ["mon_hours", "tue_hours", "wed_hours", "thu_hours", "fri_hours"];
      for (const day of dayKeys) {
        const total = entries.reduce((s, e) => s + (e[day] || 0), 0);
        let target = randBetween(7.5, 8.5);
        if (hasOvertime && Math.random() < 0.3) target = randBetween(9, 11);
        if (total > 0 && total !== target) {
          const scale = target / total;
          for (const e of entries) {
            e[day] = Math.round((e[day] || 0) * scale * 4) / 4;
          }
        }
      }

      // Insert entries
      const { error: entErr } = await sb.from("timesheet_entries").insert(entries);
      if (entErr) { results.push({ name: emp.name, error: entErr.message }); continue; }

      // Update status
      const update = { status: targetStatus };
      if (targetStatus === "submitted" || targetStatus === "approved") {
        update.submitted_at = new Date().toISOString();
      }
      await sb.from("timesheets").update(update).eq("id", timesheetId);

      const totalHours = entries.reduce((s, e) =>
        s + (e.mon_hours || 0) + (e.tue_hours || 0) + (e.wed_hours || 0) + (e.thu_hours || 0) + (e.fri_hours || 0) + (e.sat_hours || 0) + (e.sun_hours || 0), 0);

      results.push({ name: emp.name, hours: Math.round(totalHours * 10) / 10, entries: entries.length, hasLeave, hasOvertime });
      created++;
    }

    // Test data generation creates timesheets in arbitrary states across
    // arbitrary weeks; flush every cached week for the org so the
    // dashboard reflects what was just generated instead of waiting on
    // the 30s TTL.
    invalidateWeekDashboard(currentOrgId);
    statusMsg.textContent = "";
    resultsEl.style.display = "";
    resultsEl.innerHTML = `
      <p style="color:var(--success);font-weight:600">${created} timesheet${created !== 1 ? "s" : ""} generated</p>
      <table class="small">
        <thead><tr><th>Employee</th><th>Entries</th><th class="num">Hours</th><th>Leave</th><th>OT</th></tr></thead>
        <tbody>
          ${results.map((r) => r.error
            ? `<tr><td>${escapeHtml(r.name)}</td><td colspan="4" style="color:var(--danger)">${escapeHtml(r.error)}</td></tr>`
            : `<tr>
                <td>${escapeHtml(r.name)}</td>
                <td>${r.entries}</td>
                <td class="num">${fmtHours(r.hours)}</td>
                <td>${r.hasLeave ? "✓" : ""}</td>
                <td>${r.hasOvertime ? "✓" : ""}</td>
              </tr>`
          ).join("")}
        </tbody>
      </table>
    `;

    notice(`Generated ${created} timesheets for ${weekStr}`, "success");
  } catch (err) {
    notice(err.message || "Generation failed", "error");
    statusMsg.textContent = "";
  }

  btn.disabled = false;
});

/* ---------------------------------------------------------------- leave queue */

// Admin leave queue — full org visibility plus approve/reject.
// Approval is single-step (migration 150): approving here — or a manager
// approving from their Leave page — populates the employee's timesheet
// immediately. pending_admin is a legacy status kept for old rows.
function adminLeaveStatusBadge(status) {
  switch (status) {
    case "pending_employee": return `<span class="dept-badge dept-badge-submitted">Awaiting employee</span>`;
    case "pending_manager": return `<span class="dept-badge dept-badge-draft">Pending</span>`;
    case "pending_admin":   return `<span class="dept-badge dept-badge-draft">Pending</span>`;
    case "approved":        return `<span class="dept-badge dept-badge-approved">Approved</span>`;
    case "rejected":        return `<span class="dept-badge dept-badge-rejected">Rejected</span>`;
    case "cancelled":       return `<span class="dept-badge dept-badge-none">Cancelled</span>`;
    default:                return `<span class="dept-badge dept-badge-none">${escapeHtml(status || "")}</span>`;
  }
}

// Sub-tab: "approvals" (pending action queue) | "changes" | "all" (history).
let alSubView = "approvals";

document.querySelectorAll("[data-al-view]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-al-view]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    alSubView = btn.dataset.alView;
    // The status filter only makes sense on the All Requests view.
    document.getElementById("al-filter-row").style.display = alSubView === "all" ? "" : "none";
    loadAdminLeave();
  });
});

async function loadAdminLeave() {
  const body = document.getElementById("admin-leave-body");
  const filterEl = document.getElementById("admin-leave-filter");
  if (!body || !currentOrgId) return;
  body.innerHTML = skeletonRows(8);

  // Disambiguate the users embed: leave_requests has three FKs to users
  // (user_id, reviewed_by, manager_reviewed_by), so a bare users(name)
  // is ambiguous. Pin it to the user_id FK by constraint name.
  let query = sb.from("leave_requests")
    .select("id, start_date, end_date, hours_per_day, skip_weekends, reason, status, manager_review_note, review_note, change_request_type, change_request_note, proposed_start_date, proposed_end_date, proposed_hours_per_day, proposed_skip_weekends, proposed_leave_type_id, created_at, users!leave_requests_user_id_fkey(name), leave_types!leave_requests_leave_type_id_fkey(name)")
    .eq("organisation_id", currentOrgId);

  if (alSubView === "approvals") {
    // Action queue — anything still awaiting an approval decision.
    // pending_admin only exists on legacy rows but is kept for safety.
    query = query.in("status", ["pending_manager", "pending_admin"]);
  } else if (alSubView === "changes") {
    // Approved leave with an employee cancel/amend request.
    query = query.eq("status", "approved").not("change_request_type", "is", null);
  } else {
    const filter = filterEl?.value || "all";
    if (filter === "pending") query = query.in("status", ["pending_manager", "pending_admin"]);
    else if (filter !== "all") query = query.eq("status", filter);
  }

  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) {
    body.innerHTML = `<tr><td colspan="8" class="muted small" style="text-align:center;color:#c00">${escapeHtml(error.message)}</td></tr>`;
    return;
  }

  // Count of items needing admin action drives the badges — fetched
  // separately so they're right regardless of the active sub-view.
  void refreshAdminLeaveBadge();

  const rows = data || [];
  if (!rows.length) {
    const msg = alSubView === "approvals"
      ? "Nothing awaiting your approval. 🎉"
      : alSubView === "changes"
        ? "No cancellation or amendment requests."
        : "No leave requests match this filter.";
    body.innerHTML = `<tr><td colspan="8" class="muted small" style="text-align:center;padding:16px">${msg}</td></tr>`;
    return;
  }

  body.innerHTML = rows.map((r) => {
    const dateRange = r.start_date === r.end_date ? r.start_date : `${r.start_date} → ${r.end_date}`;
    const canAct = r.status === "pending_admin" || r.status === "pending_manager";
    const hasChange = !!r.change_request_type;
    const total = leaveTotalHours(r.start_date, r.end_date, r.hours_per_day, r.skip_weekends);
    const notes = [];
    if (r.reason)              notes.push(escapeHtml(r.reason));
    if (r.manager_review_note) notes.push(`<em class="muted small">Manager: ${escapeHtml(r.manager_review_note)}</em>`);
    if (r.review_note)         notes.push(`<em class="muted small">Admin: ${escapeHtml(r.review_note)}</em>`);
    const isAmend = r.change_request_type === "amend" && r.proposed_start_date;
    if (hasChange) {
      const label = r.change_request_type === "cancel" ? "Cancellation requested" : "Amendment requested";
      let detail = r.change_request_note ? `: ${escapeHtml(r.change_request_note)}` : "";
      if (isAmend) {
        const pRange = r.proposed_start_date === r.proposed_end_date
          ? r.proposed_start_date : `${r.proposed_start_date} → ${r.proposed_end_date}`;
        const pTotal = leaveTotalHours(r.proposed_start_date, r.proposed_end_date, r.proposed_hours_per_day, r.proposed_skip_weekends);
        detail = ` → change to ${escapeHtml(pRange)}, ${fmtHours(r.proposed_hours_per_day)}h/day (${fmtHours(pTotal)}h total)`;
      }
      notes.push(`<em class="small" style="color:var(--warning)">${label}${detail}</em>`);
    }
    // In the Change requests view, offer Revoke (pull off timesheet +
    // cancel) and Dismiss (clear the flag, keep the leave). Amendments
    // also get Apply (swap in the proposed values). Elsewhere, pending
    // rows get Approve/Reject.
    let actions = "";
    if (alSubView === "changes" || (hasChange && r.status === "approved")) {
      actions = `
        ${isAmend ? `<button class="small apply-al-btn">Apply</button>` : ""}
        <button class="${isAmend ? "ghost " : ""}small revoke-al-btn">Revoke</button>
        <button class="ghost small dismiss-al-btn">Dismiss</button>`;
    } else if (canAct) {
      actions = `
        <button class="small approve-al-btn">Approve</button>
        <button class="ghost small reject-al-btn">Reject</button>`;
    }
    // Developer-only hard delete for clearing test data.
    if (ctx.isDeveloper) {
      actions += ` <button class="ghost small dev-delete-al-btn" title="Delete (dev)" style="color:var(--danger)">🗑</button>`;
    }
    return `<tr data-id="${r.id}">
      <td>${escapeHtml(r.users?.name || "")}</td>
      <td>${escapeHtml(r.leave_types?.name || "")}</td>
      <td class="small">${dateRange}</td>
      <td class="num">${fmtHours(r.hours_per_day)}</td>
      <td class="num"><strong>${fmtHours(total)}</strong></td>
      <td>${adminLeaveStatusBadge(r.status)}</td>
      <td class="small">${notes.length ? notes.join("<br>") : `<span class="muted">—</span>`}</td>
      <td style="white-space:nowrap">${actions}</td>
    </tr>`;
  }).join("");

  body.querySelectorAll(".approve-al-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.closest("tr").dataset.id);
      if (!await confirmDialog({ title: "Approve leave", message: "Approve this request? The employee's timesheet will be populated with the leave hours automatically.", confirmText: "Approve" })) return;
      const { error: e } = await sb.rpc("approve_leave_request", { p_request_id: id, p_note: null });
      if (e) return notice(e.message, "error");
      notice("Approved — timesheet populated", "success");
      invalidateWeekDashboard(currentOrgId);
      await loadAdminLeave();
    });
  });

  body.querySelectorAll(".reject-al-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.closest("tr").dataset.id);
      const note = await promptDialog({ title: "Reject leave", message: "Reason for rejection (optional):" }) || null;
      const { error: e } = await sb.rpc("reject_leave_request", { p_request_id: id, p_note: note });
      if (e) return notice(e.message, "error");
      notice("Leave request rejected", "success");
      await loadAdminLeave();
    });
  });

  body.querySelectorAll(".revoke-al-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.closest("tr").dataset.id);
      if (!await confirmDialog({ title: "Revoke leave", message: "Cancel this approved leave and remove the hours from the employee's timesheet?", confirmText: "Revoke", danger: true })) return;
      const { error: e } = await sb.rpc("revoke_leave_request", { p_request_id: id, p_note: null });
      if (e) return notice(e.message, "error");
      notice("Leave revoked and removed from timesheet", "success");
      invalidateWeekDashboard(currentOrgId);
      await loadAdminLeave();
    });
  });

  body.querySelectorAll(".dismiss-al-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.closest("tr").dataset.id);
      if (!await confirmDialog({ title: "Dismiss change request", message: "Clear the change request and keep the leave as approved?", confirmText: "Dismiss" })) return;
      const { error: e } = await sb.rpc("dismiss_leave_change_request", { p_request_id: id });
      if (e) return notice(e.message, "error");
      notice("Change request dismissed", "success");
      await loadAdminLeave();
    });
  });

  body.querySelectorAll(".apply-al-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.closest("tr").dataset.id);
      if (!await confirmDialog({ title: "Apply amendment", message: "Apply the employee's proposed changes? The old leave hours are removed from the timesheet and the new ones populated.", confirmText: "Apply" })) return;
      const { error: e } = await sb.rpc("apply_leave_amendment", { p_request_id: id });
      if (e) return notice(e.message, "error");
      notice("Amendment applied", "success");
      invalidateWeekDashboard(currentOrgId);
      await loadAdminLeave();
    });
  });

  body.querySelectorAll(".dev-delete-al-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.closest("tr").dataset.id);
      if (!await confirmDialog({ title: "Delete leave request (dev)", message: "Permanently delete this leave request? If it was approved, the leave hours are stripped from the timesheet first. This can't be undone.", confirmText: "Delete", danger: true })) return;
      const { error: e } = await sb.rpc("dev_delete_leave_request", { p_request_id: id });
      if (e) return notice(e.message, "error");
      notice("Leave request deleted", "success");
      invalidateWeekDashboard(currentOrgId);
      await loadAdminLeave();
    });
  });
}

// Updates both the main "Leave" tab badge and the "Awaiting approval"
// sub-tab badge with the count of pending_admin requests. The `badge`
// param is ignored beyond back-compat — both elements are looked up
// fresh each call.
async function refreshAdminLeaveBadge() {
  const [pendingRes, changeRes] = await Promise.all([
    sb.from("leave_requests").select("id", { count: "exact", head: true })
      .eq("organisation_id", currentOrgId).in("status", ["pending_manager", "pending_admin"]),
    sb.from("leave_requests").select("id", { count: "exact", head: true })
      .eq("organisation_id", currentOrgId).eq("status", "approved")
      .not("change_request_type", "is", null),
  ]);
  const setBadge = (ids, n) => {
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (n > 0) { el.textContent = String(n); el.style.display = ""; }
      else { el.style.display = "none"; }
    }
  };
  // Main Leave tab badge = pending approvals + change requests combined.
  const pending = pendingRes.count || 0;
  const changes = changeRes.count || 0;
  setBadge(["admin-leave-count"], pending + changes);
  setBadge(["al-approvals-count"], pending);
  setBadge(["al-changes-count"], changes);
}

document.getElementById("admin-leave-filter")?.addEventListener("change", loadAdminLeave);
document.getElementById("admin-leave-refresh")?.addEventListener("click", loadAdminLeave);

/* ---------------------------------------------------------------- boot */

loadOrgSettings().then(() => navLoadInfusionStatus());
applyActiveTab();
// Populate the Leave tab badge on first load regardless of which tab is
// active, so an admin landing on Dashboard still sees a pending count.
refreshAdminLeaveBadge();
