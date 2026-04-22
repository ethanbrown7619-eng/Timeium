// PTL Timesheet Configure Timesheet page.
// Combines Jobs and Tasks management into one page with nested sub-tabs.

import { getSupabase, getConfig } from "/js/supabase-client.js";
import {
  notice,
  escapeHtml,
  renderTopbar,
  requireAdmin,
} from "/js/shared.js";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";

const sb  = await getSupabase();
const cfg = await getConfig();
const ctx = await requireAdmin(sb);
let currentOrgId = ctx.currentOrgId;

renderTopbar({
  session: ctx.session,
  isDeveloper: ctx.isDeveloper,
  isManager: ctx.isManager,
  adminRow: ctx.adminRow,
  orgs: ctx.orgs,
  currentOrgId,
  onOrgChange: (id) => {
    currentOrgId = id;
    localStorage.setItem("temporium-dev-org-id", String(id));
    reloadAll();
  },
  active: "configure",
});

const JOB_STATUSES  = ["ACTIVE","PARTIAL","DISPATCHED","INVOICED","DEP","COMPLETED"];
const TASK_STATUSES = ["ACTIVE","COMPLETED"];

/* ======================================================================
 * Outer tabs: Jobs / Tasks
 * ====================================================================== */

let activeTab = "jobs";

document.querySelectorAll("[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-tab]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    activeTab = btn.dataset.tab;
    document.getElementById("tab-jobs").style.display      = activeTab === "jobs"      ? "" : "none";
    document.getElementById("tab-tasks").style.display     = activeTab === "tasks"     ? "" : "none";
    document.getElementById("tab-deptcodes").style.display = activeTab === "deptcodes" ? "" : "none";
    document.getElementById("tab-settings").style.display  = activeTab === "settings"  ? "" : "none";
    if (activeTab === "settings") loadSettings();
  });
});

/* ======================================================================
 * Shared controller factory for Jobs, Tasks, and Dept Codes.
 * ====================================================================== */

const DEPT_CODE_STATUSES = ["ACTIVE","INACTIVE"];

function makeController(kind) {
  const CONFIG = {
    jobs:      { statuses: JOB_STATUSES,       codeField: "job_code",  table: "jobs",             prefix: "jobs",      webhookKind: "jobs",       hasStatus: true },
    tasks:     { statuses: [],                  codeField: "task_code", table: "tasks",            prefix: "tasks",     webhookKind: "tasks",      hasStatus: false },
    deptcodes: { statuses: [],                  codeField: "code",      table: "department_codes", prefix: "deptcodes", webhookKind: "dept_codes", hasStatus: false },
  };
  const c = CONFIG[kind];
  const STATUSES  = c.statuses;
  const codeField = c.codeField;
  const table     = c.table;
  const prefix    = c.prefix;

  const state = {
    rows: [],
    filter: { search: "", status: "" },
    page: 1,
    subView: "view",
    uploadedRows: [],
    uploadedHeaders: [],
  };

  // Sub-tab switching
  const dataAttr = `data-${prefix}-view`;
  document.querySelectorAll(`[${dataAttr}]`).forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(`[${dataAttr}]`).forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.subView = btn.getAttribute(dataAttr);
      document.getElementById(`${prefix}-view`).style.display   = state.subView === "view"   ? "" : "none";
      document.getElementById(`${prefix}-add`).style.display    = state.subView === "add"    ? "" : "none";
      document.getElementById(`${prefix}-import`).style.display = state.subView === "import" ? "" : "none";
      if (state.subView === "import") loadImportConfig();
    });
  });

  // Filters
  document.getElementById(`${prefix}-search`).addEventListener("input", (e) => {
    state.filter.search = e.target.value.trim().toLowerCase();
    state.page = 1;
    renderList();
  });
  const statusFilterEl = document.getElementById(`${prefix}-status-filter`);
  if (statusFilterEl) {
    statusFilterEl.addEventListener("change", (e) => {
      state.filter.status = e.target.value;
      state.page = 1;
      renderList();
    });
  }

  async function load() {
    if (!currentOrgId) return;
    try {
      const PAGE = 1000;
      let all = [];
      let from = 0;
      while (true) {
        const { data, error } = await sb
          .from(table)
          .select(`id, ${codeField}, description, status, source, last_synced_at`)
          .eq("organisation_id", currentOrgId)
          .order(codeField, { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) throw error;
        all = all.concat(data || []);
        if (!data || data.length < PAGE) break;
        from += PAGE;
      }
      state.rows = all;
      state.rows.sort((a, b) => {
        const aActive = a.status === "ACTIVE" ? 0 : 1;
        const bActive = b.status === "ACTIVE" ? 0 : 1;
        if (aActive !== bActive) return aActive - bActive;
        return String(a[codeField]).localeCompare(String(b[codeField]));
      });
      renderList();
    } catch (err) {
      console.error(err);
      notice(err.message || `Failed to load ${kind}`, "error");
    }
  }

  const PER_PAGE = 200;

  function renderList() {
    const body = document.getElementById(`${prefix}-body`);
    const paginationEl = document.getElementById(`${prefix}-pagination`);
    const filtered = state.rows.filter((r) => {
      if (state.filter.status && r.status !== state.filter.status) return false;
      if (!state.filter.search) return true;
      const q = state.filter.search;
      return (
        String(r[codeField]).toLowerCase().includes(q) ||
        (r.description || "").toLowerCase().includes(q)
      );
    });

    const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
    if (state.page > totalPages) state.page = totalPages;
    const start = (state.page - 1) * PER_PAGE;
    const pageRows = filtered.slice(start, start + PER_PAGE);

    document.getElementById(`${prefix}-summary`).textContent =
      `${filtered.length} total · page ${state.page} of ${totalPages}`;

    const colCount = c.hasStatus ? 6 : 5;
    if (!pageRows.length) {
      body.innerHTML = `<tr><td colspan="${colCount}" class="muted small" style="text-align:center">No ${kind} match.</td></tr>`;
      paginationEl.innerHTML = "";
      return;
    }

    body.innerHTML = pageRows.map((r) => `
      <tr data-id="${r.id}">
        <td><strong>${escapeHtml(r[codeField])}</strong></td>
        <td>${escapeHtml(r.description || "")}</td>
        ${c.hasStatus ? `<td>
          <select class="status-cell" ${ctx.isAdminOrHigher ? "" : "disabled"}>
            ${STATUSES.map((s) =>
              `<option value="${s}"${s === r.status ? " selected" : ""}>${s}</option>`
            ).join("")}
          </select>
        </td>` : ""}
        <td><span class="small muted">${escapeHtml(r.source || "")}</span></td>
        <td class="small muted">${r.last_synced_at ? new Date(r.last_synced_at).toLocaleString() : ""}</td>
        <td>
          ${ctx.isAdminOrHigher
            ? `<button class="ghost small delete-btn" title="Delete">✕</button>`
            : ""}
        </td>
      </tr>
    `).join("");

    // Pagination controls
    if (totalPages > 1) {
      paginationEl.innerHTML = `
        <button class="ghost" id="${prefix}-prev" ${state.page <= 1 ? "disabled" : ""}>← Prev</button>
        <span class="page-info">Page ${state.page} of ${totalPages}</span>
        <button class="ghost" id="${prefix}-next" ${state.page >= totalPages ? "disabled" : ""}>Next →</button>
      `;
      document.getElementById(`${prefix}-prev`)?.addEventListener("click", () => {
        if (state.page > 1) { state.page--; renderList(); }
      });
      document.getElementById(`${prefix}-next`)?.addEventListener("click", () => {
        if (state.page < totalPages) { state.page++; renderList(); }
      });
    } else {
      paginationEl.innerHTML = "";
    }

    if (c.hasStatus) body.querySelectorAll(".status-cell").forEach((sel) => {
      sel.addEventListener("change", async (e) => {
        const tr = e.target.closest("tr");
        const id = Number(tr.dataset.id);
        const newStatus = e.target.value;
        try {
          const { error } = await sb.from(table).update({ status: newStatus }).eq("id", id);
          if (error) throw error;
          const r = state.rows.find((x) => x.id === id);
          if (r) r.status = newStatus;
          notice("Updated", "success");
        } catch (err) {
          notice(err.message || "Update failed", "error");
        }
      });
    });

    body.querySelectorAll(".delete-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        const tr = e.target.closest("tr");
        const id = Number(tr.dataset.id);
        const r = state.rows.find((x) => x.id === id);
        if (!r) return;
        if (!confirm(`Delete ${kind.slice(0, -1)} ${r[codeField]}?`)) return;
        try {
          const { error } = await sb.from(table).delete().eq("id", id);
          if (error) throw error;
          state.rows = state.rows.filter((x) => x.id !== id);
          renderList();
          notice("Deleted", "success");
        } catch (err) {
          notice(err.message || "Delete failed", "error");
        }
      });
    });
  }

  /* ---------- Add form ---------- */

  const ADD_FORM_IDS = {
    jobs:      { form: "add-job-form",      code: "aj-code",  desc: "aj-desc",  status: "aj-status" },
    tasks:     { form: "add-task-form",     code: "at-code",  desc: "at-desc",  status: null },
    deptcodes: { form: "add-deptcode-form", code: "adc-code", desc: "adc-desc", status: null },
  };
  const formIds = ADD_FORM_IDS[kind];

  document.getElementById(formIds.form).addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!ctx.isAdminOrHigher) return notice("Admins only", "warn");
    const codeInput   = document.getElementById(formIds.code);
    const descInput   = document.getElementById(formIds.desc);
    const statusInput = formIds.status ? document.getElementById(formIds.status) : null;
    const code = codeInput.value.trim();
    const desc = descInput.value.trim() || null;
    const status = statusInput ? statusInput.value : "ACTIVE";
    if (!code) return;
    try {
      const { error } = await sb
        .from(table)
        .upsert(
          { organisation_id: currentOrgId, [codeField]: code, description: desc, status, source: "manual" },
          { onConflict: `organisation_id,${codeField}` }
        );
      if (error) throw error;
      notice(`Saved ${code}`, "success");
      e.target.reset();
      await load();
    } catch (err) {
      notice(err.message || "Save failed", "error");
    }
  });

  /* ---------- Import config (webhook) ---------- */

  function webhookUrl() {
    return `${cfg.supabaseUrl}/rest/v1/rpc/ingest_${c.webhookKind}_via_webhook`;
  }

  async function loadImportConfig() {
    document.getElementById(`${prefix}-webhook-url`).value = webhookUrl();
    document.getElementById(`${prefix}-anon-key`).value    = cfg.supabaseAnonKey;
    try {
      const { data, error } = await sb
        .from("organisations")
        .select(`${c.webhookKind}_webhook_key, ${c.webhookKind}_import_map`)
        .eq("id", currentOrgId)
        .maybeSingle();
      if (error) throw error;
      document.getElementById(`${prefix}-api-key`).value = data?.[`${c.webhookKind}_webhook_key`] || "";
      const map = data?.[`${c.webhookKind}_import_map`] || {};
      document.getElementById(`${prefix}-mp-code`).value   = map.code_column        || "";
      document.getElementById(`${prefix}-mp-desc`).value   = map.description_column || "";
      if (c.hasStatus) {
        document.getElementById(`${prefix}-mp-status`).value = map.status_column      || "";
        renderWebhookStatusMapRows(map.status_map || {});
      }
    } catch (err) {
      notice(err.message || "Failed to load import config", "error");
    }
  }

  function renderWebhookStatusMapRows(statusMap) {
    const el = document.getElementById(`${prefix}-status-map-rows`);
    const rows = Object.entries(statusMap);
    if (!rows.length) rows.push(["", ""]);
    el.innerHTML = rows.map(([from, to]) => webhookStatusRow(from, to)).join("");
  }

  function webhookStatusRow(from, to) {
    return `
      <div class="row-flex mb-sm status-map-row" style="gap:8px">
        <input class="sm-from" placeholder="Source value" value="${escapeHtml(from)}" style="flex:1" />
        <span class="muted">→</span>
        <select class="sm-to" style="width:200px">
          ${STATUSES.map((s) =>
            `<option value="${s}"${s === to ? " selected" : ""}>${s}</option>`
          ).join("")}
        </select>
        <button type="button" class="ghost sm-del" title="Remove">✕</button>
      </div>
    `;
  }

  if (c.hasStatus) {
    document.getElementById(`${prefix}-add-status-row`).addEventListener("click", () => {
      document.getElementById(`${prefix}-status-map-rows`)
        .insertAdjacentHTML("beforeend", webhookStatusRow("", "ACTIVE"));
    });

    document.getElementById(`${prefix}-status-map-rows`).addEventListener("click", (e) => {
      if (e.target.classList.contains("sm-del")) {
        e.target.closest(".status-map-row").remove();
      }
    });
  }

  document.getElementById(`${prefix}-mapping-form`).addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!ctx.isAdminOrHigher) return notice("Admins only", "warn");
    const statusMap = {};
    if (c.hasStatus) {
      document.querySelectorAll(`#${prefix}-status-map-rows .status-map-row`).forEach((row) => {
        const from = row.querySelector(".sm-from").value.trim();
        const to   = row.querySelector(".sm-to").value;
        if (from) statusMap[from] = to;
      });
    }
    const mapping = {
      code_column:        document.getElementById(`${prefix}-mp-code`).value.trim(),
      description_column: document.getElementById(`${prefix}-mp-desc`).value.trim(),
    };
    if (c.hasStatus) {
      mapping.status_column = document.getElementById(`${prefix}-mp-status`).value.trim();
      mapping.status_map    = statusMap;
    }
    try {
      const { error } = await sb.rpc("save_import_mapping", {
        p_kind: c.webhookKind, p_mapping: mapping, p_org_id: currentOrgId,
      });
      if (error) throw error;
      notice("Mapping saved", "success");
    } catch (err) {
      notice(err.message || "Save failed", "error");
    }
  });

  document.getElementById(`${prefix}-rotate-key-btn`).addEventListener("click", async () => {
    if (!ctx.isAdminOrHigher) return notice("Admins only", "warn");
    const existing = document.getElementById(`${prefix}-api-key`).value;
    if (existing && !confirm("Replace the existing key? Any flows using the old key will stop working until updated.")) return;
    try {
      const { data, error } = await sb.rpc("rotate_import_key", { p_kind: c.webhookKind, p_org_id: currentOrgId });
      if (error) throw error;
      document.getElementById(`${prefix}-api-key`).value = data;
      notice("New key generated", "success");
    } catch (err) {
      notice(err.message || "Failed to rotate key", "error");
    }
  });

  /* ---------- File upload ---------- */

  const dropZone = document.getElementById(`${prefix}-drop-zone`);
  const fileInput = document.getElementById(`${prefix}-file-input`);
  const preview = document.getElementById(`${prefix}-upload-preview`);

  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
  });

  async function handleFile(file) {
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json(ws, { defval: "" });
      if (!json.length) return notice("Sheet is empty", "warn");
      state.uploadedRows = json;
      state.uploadedHeaders = Object.keys(json[0]);
      document.getElementById(`${prefix}-upload-filename`).textContent = file.name;
      document.getElementById(`${prefix}-upload-row-count`).textContent = `${json.length} rows`;
      document.getElementById(`${prefix}-upload-columns`).textContent = state.uploadedHeaders.join(", ");

      const selIds = [`${prefix}-up-code`, `${prefix}-up-desc`];
      if (c.hasStatus) selIds.push(`${prefix}-up-status`);
      for (const selId of selIds) {
        const sel = document.getElementById(selId);
        if (!sel) continue;
        const allowNone = !selId.endsWith("up-code");
        sel.innerHTML = (allowNone ? `<option value="">(none)</option>` : "") +
          state.uploadedHeaders.map((h) => `<option value="${escapeHtml(h)}">${escapeHtml(h)}</option>`).join("");
      }

      for (const h of state.uploadedHeaders) {
        const hl = h.toLowerCase();
        if (kind === "jobs") {
          if (hl.includes("jobid") || hl.includes("job_code") || hl.includes("job number") || hl === "code" || hl === "id")
            document.getElementById(`${prefix}-up-code`).value = h;
        } else if (kind === "tasks") {
          if (hl.includes("task") && (hl.includes("code") || hl.includes("id")))
            document.getElementById(`${prefix}-up-code`).value = h;
          else if (hl === "code" || hl === "id")
            document.getElementById(`${prefix}-up-code`).value = h;
        } else if (kind === "deptcodes") {
          if (hl.includes("dept") || hl.includes("department") || hl === "code")
            document.getElementById(`${prefix}-up-code`).value = h;
        }
        if (hl.includes("desc") || hl.includes("title"))
          document.getElementById(`${prefix}-up-desc`).value = h;
        if (c.hasStatus && hl.includes("status"))
          document.getElementById(`${prefix}-up-status`).value = h;
      }

      if (c.hasStatus) refreshUploadStatusMap();
      dropZone.style.display = "none";
      preview.style.display = "";
    } catch (err) {
      console.error(err);
      notice("Failed to parse file: " + (err.message || err), "error");
    }
  }

  function guessStatus(raw) {
    const v = raw.replace(/\*/g, "").trim().toUpperCase();
    if (STATUSES.includes(v)) return v;
    if (v.startsWith("COMP")) return "COMPLETED";
    if (kind === "jobs") {
      if (v.startsWith("DISP") || v === "DSPCH") return "DISPATCHED";
      if (v.startsWith("INV")) return "INVOICED";
    }
    return "ACTIVE";
  }

  function uploadStatusRow(from, to) {
    return `
      <div class="row-flex mb-sm status-map-row" style="gap:8px">
        <input class="sm-from" value="${escapeHtml(from)}" readonly style="flex:1;background:var(--surface-alt)" />
        <span class="muted">→</span>
        <select class="sm-to" style="width:200px">
          ${STATUSES.map((s) =>
            `<option value="${s}"${s === to ? " selected" : ""}>${s}</option>`
          ).join("")}
        </select>
      </div>
    `;
  }

  function refreshUploadStatusMap() {
    if (!c.hasStatus) return;
    const statusCol = document.getElementById(`${prefix}-up-status`)?.value;
    const mapEl = document.getElementById(`${prefix}-upload-status-map`);
    if (!statusCol || !mapEl) { if (mapEl) mapEl.innerHTML = ""; return; }
    const unique = [...new Set(state.uploadedRows.map((r) => String(r[statusCol] || "").trim()).filter(Boolean))];
    mapEl.innerHTML = unique.map((v) => uploadStatusRow(v, guessStatus(v))).join("");
  }

  if (c.hasStatus) {
    document.getElementById(`${prefix}-up-status`)?.addEventListener("change", refreshUploadStatusMap);

    document.getElementById(`${prefix}-upload-add-status-row`)?.addEventListener("click", () => {
      const mapEl = document.getElementById(`${prefix}-upload-status-map`);
      mapEl.insertAdjacentHTML("beforeend", uploadStatusRow("", "ACTIVE"));
      const last = mapEl.lastElementChild;
      last.querySelector(".sm-from").removeAttribute("readonly");
      last.querySelector(".sm-from").style.background = "";
    });
  }

  document.getElementById(`${prefix}-upload-clear`).addEventListener("click", () => {
    state.uploadedRows = [];
    state.uploadedHeaders = [];
    preview.style.display = "none";
    dropZone.style.display = "";
    fileInput.value = "";
    document.getElementById(`${prefix}-upload-progress`).textContent = "";
  });

  document.getElementById(`${prefix}-upload-import-btn`).addEventListener("click", async () => {
    if (!ctx.isAdminOrHigher) return notice("Admins only", "warn");
    if (!state.uploadedRows.length) return notice("No rows to import", "warn");

    const codeCol   = document.getElementById(`${prefix}-up-code`).value;
    const descCol   = document.getElementById(`${prefix}-up-desc`).value;
    const statusCol = c.hasStatus ? document.getElementById(`${prefix}-up-status`)?.value : null;
    if (!codeCol) return notice("Select a code column", "warn");

    const statusMap = {};
    if (c.hasStatus) {
      document.querySelectorAll(`#${prefix}-upload-status-map .status-map-row`).forEach((row) => {
        const from = row.querySelector(".sm-from").value.trim();
        const to   = row.querySelector(".sm-to").value;
        if (from) statusMap[from] = to;
      });
    }

    const resolveStatus = (raw) => {
      const trimmed = String(raw || "").trim();
      if (statusMap[trimmed]) return statusMap[trimmed];
      const upper = trimmed.replace(/\*/g, "").toUpperCase();
      if (STATUSES.includes(upper)) return upper;
      return "ACTIVE";
    };

    const progress = document.getElementById(`${prefix}-upload-progress`);
    const btn = document.getElementById(`${prefix}-upload-import-btn`);
    btn.disabled = true;

    const deduped = new Map();
    for (const r of state.uploadedRows) {
      const code = String(r[codeCol] || "").trim();
      if (!code) continue;
      deduped.set(code, {
        organisation_id: currentOrgId,
        [codeField]: code,
        description: descCol ? (String(r[descCol] || "").trim() || null) : null,
        status: statusCol ? resolveStatus(r[statusCol]) : "ACTIVE",
        source: "import",
      });
    }
    const allRows = [...deduped.values()];
    const total = allRows.length;
    const BATCH = 500;
    let imported = 0;
    let errors = 0;

    for (let i = 0; i < allRows.length; i += BATCH) {
      const rows = allRows.slice(i, i + BATCH);
      try {
        const { error } = await sb.from(table).upsert(rows, { onConflict: `organisation_id,${codeField}` });
        if (error) throw error;
        imported += rows.length;
      } catch (err) {
        console.error("Batch error", err);
        errors += rows.length;
      }
      progress.textContent = `${imported + errors} / ${total}…`;
    }

    btn.disabled = false;
    progress.textContent = "";
    notice(`Imported ${imported} ${kind}` + (errors ? `, ${errors} failed` : ""), errors ? "warn" : "success");
    await load();
  });

  return { load, loadImportConfig };
}

/* ---------------------------------------------------------------- settings */

const SETTINGS_FIELDS = "approval_workflow, deadline_week, deadline_day, deadline_time, notify_overdue, notify_reminder, reminder_day, reminder_time, clock_tolerance_hours, notify_discrepancy, discrepancy_day, discrepancy_time";

async function loadSettings() {
  if (!currentOrgId) return;
  try {
    const { data, error } = await sb
      .from("organisations")
      .select(SETTINGS_FIELDS)
      .eq("id", currentOrgId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return;

    // Approval workflow
    const wf = data.approval_workflow || "manager_then_admin";
    const radio = document.querySelector(`input[name="approval_workflow"][value="${wf}"]`);
    if (radio) radio.checked = true;

    // Deadline
    document.getElementById("deadline-week").value = data.deadline_week || "following_week";
    document.getElementById("deadline-day").value = data.deadline_day || "monday";
    document.getElementById("deadline-time").value = (data.deadline_time || "08:00").slice(0, 5);
    updateDeadlinePreview();

    // Notifications
    document.getElementById("notify-overdue").checked = !!data.notify_overdue;
    document.getElementById("notify-reminder").checked = !!data.notify_reminder;
    document.getElementById("reminder-day").value = data.reminder_day || "friday";
    document.getElementById("reminder-time").value = (data.reminder_time || "09:00").slice(0, 5);
    document.getElementById("reminder-schedule").style.display = data.notify_reminder ? "" : "none";

    // Clock vs Timesheet
    document.getElementById("clock-tolerance").value = String(data.clock_tolerance_hours ?? 0.5);
    document.getElementById("notify-discrepancy").checked = !!data.notify_discrepancy;
    document.getElementById("discrepancy-day").value = data.discrepancy_day || "monday";
    document.getElementById("discrepancy-time").value = (data.discrepancy_time || "10:00").slice(0, 5);
    document.getElementById("discrepancy-schedule").style.display = data.notify_discrepancy ? "" : "none";
  } catch (err) {
    notice(err.message || "Failed to load settings", "error");
  }
}

function updateDeadlinePreview() {
  const week = document.getElementById("deadline-week").value;
  const day = document.getElementById("deadline-day").value;
  const time = document.getElementById("deadline-time").value || "08:00";
  const weekLabel = week === "this_week" ? "the same week" : "the following week";
  const dayLabel = day.charAt(0).toUpperCase() + day.slice(1);
  document.getElementById("deadline-preview").textContent =
    `Timesheets are due by ${dayLabel} at ${time} of ${weekLabel}.`;
}

document.getElementById("deadline-week").addEventListener("change", updateDeadlinePreview);
document.getElementById("deadline-day").addEventListener("change", updateDeadlinePreview);
document.getElementById("deadline-time").addEventListener("input", updateDeadlinePreview);

// Approval workflow save
document.getElementById("save-workflow-btn").addEventListener("click", async () => {
  if (!ctx.isAdminOrHigher) return notice("Admins only", "warn");
  if (!currentOrgId) return;
  const selected = document.querySelector('input[name="approval_workflow"]:checked');
  if (!selected) return notice("Select an option", "warn");
  try {
    const { error } = await sb
      .from("organisations")
      .update({ approval_workflow: selected.value })
      .eq("id", currentOrgId);
    if (error) throw error;
    notice("Approval workflow saved", "success");
    flashStatus("workflow-status");
  } catch (err) {
    notice(err.message || "Save failed", "error");
  }
});

// Deadline save
document.getElementById("save-deadline-btn").addEventListener("click", async () => {
  if (!ctx.isAdminOrHigher) return notice("Admins only", "warn");
  if (!currentOrgId) return;
  try {
    const { error } = await sb
      .from("organisations")
      .update({
        deadline_week: document.getElementById("deadline-week").value,
        deadline_day: document.getElementById("deadline-day").value,
        deadline_time: document.getElementById("deadline-time").value || "08:00",
      })
      .eq("id", currentOrgId);
    if (error) throw error;
    notice("Deadline saved", "success");
    flashStatus("deadline-status");
  } catch (err) {
    notice(err.message || "Save failed", "error");
  }
});

// Notification toggle
document.getElementById("notify-reminder").addEventListener("change", (e) => {
  document.getElementById("reminder-schedule").style.display = e.target.checked ? "" : "none";
});

// Notifications save
document.getElementById("save-notifications-btn").addEventListener("click", async () => {
  if (!ctx.isAdminOrHigher) return notice("Admins only", "warn");
  if (!currentOrgId) return;
  try {
    const { error } = await sb
      .from("organisations")
      .update({
        notify_overdue: document.getElementById("notify-overdue").checked,
        notify_reminder: document.getElementById("notify-reminder").checked,
        reminder_day: document.getElementById("reminder-day").value,
        reminder_time: document.getElementById("reminder-time").value || "09:00",
      })
      .eq("id", currentOrgId);
    if (error) throw error;
    notice("Notification settings saved", "success");
    flashStatus("notifications-status");
  } catch (err) {
    notice(err.message || "Save failed", "error");
  }
});

// Discrepancy notification toggle
document.getElementById("notify-discrepancy").addEventListener("change", (e) => {
  document.getElementById("discrepancy-schedule").style.display = e.target.checked ? "" : "none";
});

// Clock vs Timesheet save
document.getElementById("save-clock-btn").addEventListener("click", async () => {
  if (!ctx.isAdminOrHigher) return notice("Admins only", "warn");
  if (!currentOrgId) return;
  try {
    const { error } = await sb
      .from("organisations")
      .update({
        clock_tolerance_hours: Number(document.getElementById("clock-tolerance").value) || 0.5,
        notify_discrepancy: document.getElementById("notify-discrepancy").checked,
        discrepancy_day: document.getElementById("discrepancy-day").value,
        discrepancy_time: document.getElementById("discrepancy-time").value || "10:00",
      })
      .eq("id", currentOrgId);
    if (error) throw error;
    notice("Clock vs Timesheet settings saved", "success");
    flashStatus("clock-status");
  } catch (err) {
    notice(err.message || "Save failed", "error");
  }
});

function flashStatus(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = "Saved";
  setTimeout(() => el.textContent = "", 3000);
}

/* ---------------------------------------------------------------- boot */

const jobsCtl      = makeController("jobs");
const tasksCtl     = makeController("tasks");
const deptCodesCtl = makeController("deptcodes");

// Generic copy-buttons (for both panels)
document.querySelectorAll("[data-copy]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const target = document.getElementById(btn.dataset.copy);
    if (!target?.value) return;
    try {
      await navigator.clipboard.writeText(target.value);
      notice("Copied", "success");
    } catch {
      target.select();
      document.execCommand("copy");
    }
  });
});

function reloadAll() {
  jobsCtl.load();
  tasksCtl.load();
  deptCodesCtl.load();
}

reloadAll();
