// PTL Timesheet Configure Timesheet page.
// Combines Jobs and Tasks management into one page with nested sub-tabs.

import { getSupabase, getConfig } from "/js/supabase-client.js";
import {
  notice,
  escapeHtml,
  renderTopbar,
  requireDeveloper,
  confirmDialog,
} from "/js/shared.js";

// XLSX (~600KB) loaded only when the user actually triggers an import.
let _xlsxPromise = null;
function getXLSX() {
  if (!_xlsxPromise) _xlsxPromise = import("https://esm.sh/xlsx@0.18.5");
  return _xlsxPromise;
}

const sb  = await getSupabase();
const cfg = await getConfig();
const ctx = await requireDeveloper(sb);
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
    document.getElementById("tab-jobs").style.display        = activeTab === "jobs"        ? "" : "none";
    document.getElementById("tab-tasks").style.display      = activeTab === "tasks"      ? "" : "none";
    document.getElementById("tab-deptcodes").style.display  = activeTab === "deptcodes"  ? "" : "none";
    document.getElementById("tab-stafftypes").style.display = activeTab === "stafftypes" ? "" : "none";
    document.getElementById("tab-settings").style.display   = activeTab === "settings"   ? "" : "none";
    document.getElementById("tab-xero").style.display       = activeTab === "xero"       ? "" : "none";
    if (activeTab === "stafftypes") loadSettings();
    if (activeTab === "settings") { loadSettings(); loadHolidays(); loadXeroStatus(); loadLeaveJobMapping(); }
    if (activeTab === "xero") loadXeroMapping();
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
    hasNextPage: false,
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

  // Filters. Both search and status now re-query the server — the
  // list isn't loaded in bulk anymore so we can't filter client-side.
  // Search input is debounced so typing fast doesn't fire a query
  // per keystroke.
  let searchTimer = null;
  document.getElementById(`${prefix}-search`).addEventListener("input", (e) => {
    state.filter.search = e.target.value.trim();
    state.page = 1;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => load(), 200);
  });
  const statusFilterEl = document.getElementById(`${prefix}-status-filter`);
  if (statusFilterEl) {
    statusFilterEl.addEventListener("change", (e) => {
      state.filter.status = e.target.value;
      state.page = 1;
      load();
    });
  }

  const PER_PAGE = 15;

  // Server-paginated loader. Each call fetches a single page based on
  // state.page, state.filter.search, state.filter.status. Bulk-loading
  // everything client-side (the previous approach) doesn't scale —
  // PTL has 6000+ jobs synced from Infusion and the bulk fetch took
  // multiple seconds before anything rendered. The list view isn't
  // for browsing — the search box is the primary way to find a job.
  async function load() {
    if (!currentOrgId) return;
    const body = document.getElementById(`${prefix}-body`);
    if (body) {
      const colCount = kind === "jobs" ? 7 : (c.hasStatus ? 6 : 5);
      body.innerHTML = `<tr><td colspan="${colCount}" class="muted small" style="text-align:center;padding:16px">Loading…</td></tr>`;
    }
    try {
      // No COUNT at all. A real COUNT(*) re-evaluates the row-level-
      // security policy for every row, and PTL's jobs RLS has nested
      // EXISTS subqueries — counting 6000 rows that way hangs the page
      // indefinitely. Even count:"planned" was unreliable here. Instead
      // we fetch PER_PAGE + 1 rows: if the extra row comes back there's
      // a next page. No total is shown — just Prev / Next.
      let query = sb
        .from(table)
        .select(`id, ${codeField}, description, status, source, last_synced_at${kind === "jobs" ? ", is_leave" : ""}`)
        .eq("organisation_id", currentOrgId);

      if (state.filter.status) {
        query = query.eq("status", state.filter.status);
      }
      if (state.filter.search) {
        const s = state.filter.search.replace(/[%,()]/g, " ");
        query = query.or(`${codeField}.ilike.%${s}%,description.ilike.%${s}%`);
      }

      const from = (state.page - 1) * PER_PAGE;
      const { data, error } = await query
        .order(codeField, { ascending: true })
        .range(from, from + PER_PAGE);  // +1 sentinel row to detect a next page
      if (error) throw error;

      const rows = data || [];
      state.hasNextPage = rows.length > PER_PAGE;
      state.rows = rows.slice(0, PER_PAGE);
      renderList();
    } catch (err) {
      console.error(err);
      notice(err.message || `Failed to load ${kind}`, "error");
    }
  }

  function renderList() {
    const body = document.getElementById(`${prefix}-body`);
    const paginationEl = document.getElementById(`${prefix}-pagination`);
    // state.rows is the server-returned page already; no client-side
    // filtering happens here (the server applied search + status).
    const pageRows = state.rows;

    document.getElementById(`${prefix}-summary`).textContent =
      `Page ${state.page}${state.filter.search || state.filter.status ? " (filtered)" : ""}`;

    const colCount = kind === "jobs" ? 7 : (c.hasStatus ? 6 : 5);
    if (!pageRows.length) {
      body.innerHTML = `<tr><td colspan="${colCount}" class="muted small" style="text-align:center">No ${kind} match.</td></tr>`;
      paginationEl.innerHTML = "";
      return;
    }

    body.innerHTML = pageRows.map((r) => `
      <tr data-id="${r.id}">
        <td><strong>${escapeHtml(r[codeField])}</strong></td>
        <td>${escapeHtml(r.description || "")}</td>
        ${kind === "jobs" ? `<td style="text-align:center">
          <input type="checkbox" class="leave-cell" ${r.is_leave ? "checked" : ""} ${ctx.isAdminOrHigher ? "" : "disabled"} />
        </td>` : ""}
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

    // Pagination controls — Prev/Next driven by hasNextPage (we don't
    // know the total, only whether a sentinel +1 row came back).
    if (state.page > 1 || state.hasNextPage) {
      paginationEl.innerHTML = `
        <button class="ghost" id="${prefix}-prev" ${state.page <= 1 ? "disabled" : ""}>← Prev</button>
        <span class="page-info">Page ${state.page}</span>
        <button class="ghost" id="${prefix}-next" ${state.hasNextPage ? "" : "disabled"}>Next →</button>
      `;
      document.getElementById(`${prefix}-prev`)?.addEventListener("click", () => {
        if (state.page > 1) { state.page--; load(); }
      });
      document.getElementById(`${prefix}-next`)?.addEventListener("click", () => {
        if (state.hasNextPage) { state.page++; load(); }
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

    if (kind === "jobs") body.querySelectorAll(".leave-cell").forEach((cb) => {
      cb.addEventListener("change", async (e) => {
        const tr = e.target.closest("tr");
        const id = Number(tr.dataset.id);
        const val = e.target.checked;
        try {
          const { error } = await sb.from(table).update({ is_leave: val }).eq("id", id);
          if (error) throw error;
          const r = state.rows.find((x) => x.id === id);
          if (r) r.is_leave = val;
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
        if (!await confirmDialog({ title: `Delete ${kind.slice(0, -1)}`, message: `Delete ${kind.slice(0, -1)} ${r[codeField]}?`, confirmText: "Delete", danger: true })) return;
        try {
          const { error } = await sb.from(table).delete().eq("id", id);
          if (error) throw error;
          // Re-fetch instead of splicing — the page count may have
          // changed and a server-paginated list can't infer the next
          // visible row without going back to the source.
          await load();
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
    if (!code) return notice("Code is required", "warn");
    try {
      const row = { organisation_id: currentOrgId, [codeField]: code, description: desc, status, source: "manual" };
      if (kind === "jobs") {
        row.is_leave = document.getElementById("aj-leave").checked;
      }
      const { error } = await sb
        .from(table)
        .upsert(
          row,
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
    if (existing && !await confirmDialog({ title: "Replace API key", message: "Replace the existing key? Any flows using the old key will stop working until updated.", confirmText: "Replace", danger: true })) return;
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
      const XLSX = await getXLSX();
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

/* ---------------------------------------------------------------- holidays */

let holidayRows = [];

// Populate year dropdown
const holYearSel = document.getElementById("hol-year");
const thisYear = new Date().getFullYear();
for (let y = thisYear; y <= thisYear + 3; y++) {
  holYearSel.innerHTML += `<option value="${y}">${y}</option>`;
}

document.getElementById("hol-generate-btn").addEventListener("click", async () => {
  const year = Number(holYearSel.value);
  if (!year || !currentOrgId) return;
  const { data, error } = await sb.rpc("seed_public_holidays_for_year", {
    p_org_id: currentOrgId,
    p_year: year,
  });
  if (error) return notice(error.message, "error");
  notice(`Generated NZ holidays for ${year} (${data} added)`, "success");
  await loadHolidays();
});

async function loadHolidays() {
  if (!currentOrgId) return;
  const { data, error } = await sb
    .from("public_holidays")
    .select("id, holiday_date, name")
    .eq("organisation_id", currentOrgId)
    .order("holiday_date");
  if (error) return notice(error.message, "error");
  holidayRows = data || [];
  renderHolidays();
}

function renderHolidays() {
  const body = document.getElementById("holidays-body");
  document.getElementById("holidays-count").textContent = `${holidayRows.length} holiday${holidayRows.length === 1 ? "" : "s"}`;

  if (!holidayRows.length) {
    body.innerHTML = `<tr><td colspan="3" class="muted small" style="text-align:center">No holidays added yet.</td></tr>`;
    return;
  }

  body.innerHTML = holidayRows.map((h) => {
    const d = new Date(h.holiday_date + "T00:00:00");
    const label = d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    return `<tr data-id="${h.id}">
      <td>${escapeHtml(label)}</td>
      <td>${escapeHtml(h.name)}</td>
      <td><button class="ghost small hol-delete" title="Delete">✕</button></td>
    </tr>`;
  }).join("");

  body.querySelectorAll(".hol-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.closest("tr").dataset.id);
      if (!await confirmDialog({ title: "Delete holiday", message: "Delete this holiday?", confirmText: "Delete", danger: true })) return;
      const { error } = await sb.from("public_holidays").delete().eq("id", id);
      if (error) return notice(error.message, "error");
      notice("Deleted", "success");
      await loadHolidays();
    });
  });
}

document.getElementById("hol-add-btn").addEventListener("click", async () => {
  const dateVal = document.getElementById("hol-date").value;
  const nameVal = document.getElementById("hol-name").value.trim();
  if (!dateVal || !nameVal) return notice("Date and name are required", "warn");

  const { error } = await sb.from("public_holidays").insert({
    organisation_id: currentOrgId,
    holiday_date: dateVal,
    name: nameVal,
  });
  if (error) {
    if (error.message?.includes("public_holidays_organisation_id_holiday_date_key"))
      return notice("A holiday already exists on that date", "warn");
    return notice(error.message, "error");
  }
  document.getElementById("hol-date").value = "";
  document.getElementById("hol-name").value = "";
  notice("Holiday added", "success");
  await loadHolidays();
});

/* ---------------------------------------------------------------- settings */

const SETTINGS_FIELDS = "approval_workflow, force_view_before_approval, autofill_public_holidays, public_holiday_hours, public_holiday_job_id, deadline_week, deadline_day, deadline_time, notify_overdue, notify_reminder, reminder_day, reminder_time, reminder_day_2, reminder_time_2, overdue_day, overdue_time, notify_overdue_recipient, clock_tolerance_hours, notify_discrepancy, discrepancy_day, discrepancy_time, employment_type_settings, smtp_host, smtp_port, smtp_user, smtp_from, debug_redirect_email, notify_manager_approval, manager_approval_day, manager_approval_time";

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

    // Manager approval gate
    document.getElementById("force-view-before-approval").checked = !!data.force_view_before_approval;

    // Public holiday autofill
    document.getElementById("autofill-public-holidays").checked = !!data.autofill_public_holidays;
    document.getElementById("ph-hours").value = data.public_holiday_hours ?? 8;
    document.getElementById("ph-options").style.display = data.autofill_public_holidays ? "" : "none";

    // Load jobs for the PH job picker (leave jobs only)
    const phJobSel = document.getElementById("ph-job");
    const { data: allJobs } = await sb.from("jobs").select("id, job_code, description")
      .eq("organisation_id", currentOrgId)
      .eq("is_leave", true)
      .order("job_code");
    phJobSel.innerHTML = `<option value="">— select a job —</option>` +
      (allJobs || []).map((j) =>
        `<option value="${j.id}">${escapeHtml(j.job_code)}${j.description ? " — " + escapeHtml(j.description) : ""}</option>`
      ).join("");
    if (data.public_holiday_job_id != null) {
      phJobSel.value = String(data.public_holiday_job_id);
    }

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
    document.getElementById("reminder-day-2").value = data.reminder_day_2 || "";
    document.getElementById("reminder-time-2").value = data.reminder_time_2
      ? data.reminder_time_2.slice(0, 5) : "";
    document.getElementById("reminder-schedule").style.display = data.notify_reminder ? "" : "none";
    document.getElementById("overdue-day").value = data.overdue_day || "tuesday";
    document.getElementById("overdue-time").value = (data.overdue_time || "09:00").slice(0, 5);
    document.getElementById("overdue-recipient").value = data.notify_overdue_recipient || "employee";
    document.getElementById("overdue-schedule").style.display = data.notify_overdue ? "" : "none";

    // Clock vs Timesheet
    document.getElementById("clock-tolerance").value = String(data.clock_tolerance_hours ?? 0.5);
    document.getElementById("notify-discrepancy").checked = !!data.notify_discrepancy;
    document.getElementById("discrepancy-day").value = data.discrepancy_day || "monday";
    document.getElementById("discrepancy-time").value = (data.discrepancy_time || "10:00").slice(0, 5);
    document.getElementById("discrepancy-schedule").style.display = data.notify_discrepancy ? "" : "none";

    // Staff Types
    renderStaffTypes(data.employment_type_settings);

    // SMTP (smtp_pass is never round-tripped — admin types a new one to
    // change it, blank means keep existing).
    document.getElementById("smtp-host").value = data.smtp_host || "";
    document.getElementById("smtp-port").value = data.smtp_port ?? 2525;
    document.getElementById("smtp-user").value = data.smtp_user || "";
    document.getElementById("smtp-pass").value = "";
    document.getElementById("smtp-from").value = data.smtp_from || "";
    document.getElementById("smtp-debug-redirect").value = data.debug_redirect_email || "";

    // Manager-approval digest
    document.getElementById("notify-manager-approval").checked = !!data.notify_manager_approval;
    document.getElementById("manager-approval-day").value = data.manager_approval_day || "monday";
    document.getElementById("manager-approval-time").value = (data.manager_approval_time || "09:00").slice(0, 5);
    document.getElementById("manager-approval-schedule").style.display = data.notify_manager_approval ? "" : "none";
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

// Helper: save org settings via SECURITY DEFINER RPC
async function saveOrgSettings(settings) {
  const { error } = await sb.rpc("save_org_settings", {
    p_org_id: currentOrgId,
    p_settings: settings,
  });
  if (error) throw error;
}

// Manager approval gate save
document.getElementById("save-view-gate-btn").addEventListener("click", async () => {
  if (!ctx.isAdminOrHigher) return notice("Admins only", "warn");
  if (!currentOrgId) return;
  try {
    await saveOrgSettings({ force_view_before_approval: document.getElementById("force-view-before-approval").checked });
    notice("Approval gate saved", "success");
    flashStatus("view-gate-status");
  } catch (err) {
    notice(err.message || "Save failed", "error");
  }
});

// Public holiday autofill toggle
document.getElementById("autofill-public-holidays").addEventListener("change", (e) => {
  document.getElementById("ph-options").style.display = e.target.checked ? "" : "none";
});

document.getElementById("save-ph-autofill-btn").addEventListener("click", async () => {
  if (!ctx.isAdminOrHigher) return notice("Admins only", "warn");
  if (!currentOrgId) return;
  const enabled = document.getElementById("autofill-public-holidays").checked;
  const jobId = document.getElementById("ph-job").value ? Number(document.getElementById("ph-job").value) : null;
  if (enabled && !jobId) return notice("Select a job to use for public holidays", "warn");
  try {
    await saveOrgSettings({
      autofill_public_holidays: enabled,
      public_holiday_hours: Number(document.getElementById("ph-hours").value) || 8,
      public_holiday_job_id: jobId,
    });
    notice("Public holiday autofill saved", "success");
    flashStatus("ph-autofill-status");
  } catch (err) {
    notice(err.message || "Save failed", "error");
  }
});

// Approval workflow save
document.getElementById("save-workflow-btn").addEventListener("click", async () => {
  if (!ctx.isAdminOrHigher) return notice("Admins only", "warn");
  if (!currentOrgId) return;
  const selected = document.querySelector('input[name="approval_workflow"]:checked');
  if (!selected) return notice("Select an option", "warn");
  try {
    await saveOrgSettings({ approval_workflow: selected.value });
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
    await saveOrgSettings({
      deadline_week: document.getElementById("deadline-week").value,
      deadline_day: document.getElementById("deadline-day").value,
      deadline_time: document.getElementById("deadline-time").value || "08:00",
    });
    notice("Deadline saved", "success");
    flashStatus("deadline-status");
  } catch (err) {
    notice(err.message || "Save failed", "error");
  }
});

// Notification toggles — show/hide the schedule rows in sync with the
// checkboxes. Reminder schedule controls reveal both the first and the
// optional second slot; overdue schedule reveals day/time/recipient.
document.getElementById("notify-reminder").addEventListener("change", (e) => {
  document.getElementById("reminder-schedule").style.display = e.target.checked ? "" : "none";
});
document.getElementById("notify-overdue").addEventListener("change", (e) => {
  document.getElementById("overdue-schedule").style.display = e.target.checked ? "" : "none";
});

// Notifications save
document.getElementById("save-notifications-btn").addEventListener("click", async () => {
  if (!ctx.isAdminOrHigher) return notice("Admins only", "warn");
  if (!currentOrgId) return;
  try {
    const reminderDay2 = document.getElementById("reminder-day-2").value;
    const reminderTime2 = document.getElementById("reminder-time-2").value;
    await saveOrgSettings({
      notify_overdue: document.getElementById("notify-overdue").checked,
      notify_reminder: document.getElementById("notify-reminder").checked,
      reminder_day: document.getElementById("reminder-day").value,
      reminder_time: document.getElementById("reminder-time").value || "09:00",
      // Second reminder slot is optional. Empty string on either field
      // disables it (the save_org_settings RPC nullif's empty strings).
      reminder_day_2: reminderDay2 || "",
      reminder_time_2: reminderDay2 ? (reminderTime2 || "09:00") : "",
      overdue_day: document.getElementById("overdue-day").value,
      overdue_time: document.getElementById("overdue-time").value || "09:00",
      notify_overdue_recipient: document.getElementById("overdue-recipient").value,
    });
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
    await saveOrgSettings({
      clock_tolerance_hours: Number(document.getElementById("clock-tolerance").value) || 0.5,
      notify_discrepancy: document.getElementById("notify-discrepancy").checked,
      discrepancy_day: document.getElementById("discrepancy-day").value,
      discrepancy_time: document.getElementById("discrepancy-time").value || "10:00",
    });
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

/* -------------------------------------------------------- Manager approval digest */

document.getElementById("notify-manager-approval")?.addEventListener("change", (e) => {
  document.getElementById("manager-approval-schedule").style.display = e.target.checked ? "" : "none";
});

document.getElementById("save-manager-approval-btn")?.addEventListener("click", async () => {
  if (!ctx.isAdminOrHigher) return notice("Admins only", "warn");
  if (!currentOrgId) return;
  try {
    await saveOrgSettings({
      notify_manager_approval: document.getElementById("notify-manager-approval").checked,
      manager_approval_day:    document.getElementById("manager-approval-day").value,
      manager_approval_time:   document.getElementById("manager-approval-time").value || "09:00",
    });
    notice("Manager approval reminders saved", "success");
    flashStatus("manager-approval-status");
  } catch (err) {
    notice(err.message || "Save failed", "error");
  }
});

/* -------------------------------------------------------- SMTP */

document.getElementById("save-smtp-btn").addEventListener("click", async () => {
  if (!ctx.isAdminOrHigher) return notice("Admins only", "warn");
  if (!currentOrgId) return;
  const host = document.getElementById("smtp-host").value.trim();
  const portStr = document.getElementById("smtp-port").value.trim();
  const port = portStr ? Number(portStr) : 2525;
  const user = document.getElementById("smtp-user").value.trim();
  const pass = document.getElementById("smtp-pass").value; // keep whitespace
  const from = document.getElementById("smtp-from").value.trim();

  if (host && (!Number.isFinite(port) || port < 1 || port > 65535)) {
    return notice("Port must be a number between 1 and 65535", "warn");
  }

  // Build a payload that omits smtp_pass when blank so the existing
  // password is preserved. Empty strings on other fields clear them.
  const payload = {
    smtp_host: host,
    smtp_port: host ? String(port) : "",
    smtp_user: user,
    smtp_from: from,
    debug_redirect_email: document.getElementById("smtp-debug-redirect").value.trim(),
  };
  if (pass) payload.smtp_pass = pass;

  try {
    await saveOrgSettings(payload);
    document.getElementById("smtp-pass").value = "";
    notice("SMTP settings saved", "success");
    flashStatus("smtp-status");
  } catch (err) {
    notice(err.message || "Save failed", "error");
  }
});

document.getElementById("test-smtp-btn").addEventListener("click", async () => {
  if (!ctx.isAdminOrHigher) return notice("Admins only", "warn");
  if (!currentOrgId) return;
  const to = prompt("Send test email to:", ctx.session?.user?.email || "");
  if (!to) return;
  const btn = document.getElementById("test-smtp-btn");
  btn.disabled = true;
  const statusEl = document.getElementById("smtp-status");
  statusEl.textContent = "Sending…";
  try {
    const { data, error } = await sb.functions.invoke("send-timesheet-notifications", {
      body: { force_org_id: currentOrgId, test_send_to: to },
    });
    if (error) throw error;
    if (data?.ok) {
      notice(`Test email sent to ${to}`, "success");
      statusEl.textContent = "Sent";
    } else {
      notice(data?.error || "Send failed", "error");
      statusEl.textContent = "";
    }
  } catch (err) {
    notice(err.message || "Send failed", "error");
    statusEl.textContent = "";
  } finally {
    btn.disabled = false;
    setTimeout(() => { if (statusEl.textContent === "Sent") statusEl.textContent = ""; }, 4000);
  }
});

// Preview a notification template (reminder / overdue / discrepancy) by
// having the edge function build the email body with sample data and
// route a single copy to the admin-chosen address. No live recipients,
// no last_sent_at touched.
document.getElementById("preview-send-btn")?.addEventListener("click", async () => {
  if (!ctx.isAdminOrHigher) return notice("Admins only", "warn");
  if (!currentOrgId) return;
  const kind = document.getElementById("preview-kind").value;
  const to   = document.getElementById("preview-email").value.trim();
  if (!to) return notice("Enter an email address", "warn");

  const btn = document.getElementById("preview-send-btn");
  btn.disabled = true;
  const statusEl = document.getElementById("preview-status");
  statusEl.textContent = "Sending…";
  try {
    const { data, error } = await sb.functions.invoke("send-timesheet-notifications", {
      body: { force_org_id: currentOrgId, test_kind: kind, test_redirect_to: to },
    });
    if (error) throw error;
    if (data?.ok) {
      notice(`Preview sent to ${to}`, "success");
      statusEl.textContent = "Sent";
    } else {
      notice(data?.error || "Send failed", "error");
      statusEl.textContent = "";
    }
  } catch (err) {
    notice(err.message || "Send failed", "error");
    statusEl.textContent = "";
  } finally {
    btn.disabled = false;
    setTimeout(() => { if (statusEl.textContent === "Sent") statusEl.textContent = ""; }, 4000);
  }
});

// Prefill the preview email field with the admin's own address.
const _previewEmail = document.getElementById("preview-email");
if (_previewEmail && ctx?.session?.user?.email && !_previewEmail.value) {
  _previewEmail.value = ctx.session.user.email;
}

/* -------------------------------------------------------- staff types */

const EMPLOYMENT_TYPES = ["waged", "salaried", "contractor"];
const ENTITLEMENT_KEYS = [
  { key: "public_holidays", label: "Public holidays" },
  { key: "sick_leave",      label: "Sick leave" },
  { key: "annual_leave",    label: "Annual leave" },
];

const DEFAULT_TYPE_SETTINGS = {
  waged:      { public_holidays: true,  sick_leave: true,  annual_leave: true },
  salaried:   { public_holidays: true,  sick_leave: true,  annual_leave: true },
  contractor: { public_holidays: false, sick_leave: false, annual_leave: false },
};

function renderStaffTypes(settings) {
  const merged = { ...DEFAULT_TYPE_SETTINGS, ...(settings || {}) };
  const container = document.getElementById("staff-types-container");

  container.innerHTML = EMPLOYMENT_TYPES.map((type) => {
    const cfg = merged[type] || {};
    const label = type.charAt(0).toUpperCase() + type.slice(1);
    return `
      <div style="border:1px solid var(--border);border-radius:var(--radius-box);padding:14px">
        <strong style="display:block;margin-bottom:8px">${escapeHtml(label)}</strong>
        <div class="settings-checks">
          ${ENTITLEMENT_KEYS.map((ent) => `
            <label class="settings-check">
              <input type="checkbox"
                     data-staff-type="${type}"
                     data-entitlement="${ent.key}"
                     ${cfg[ent.key] ? "checked" : ""} />
              <div>
                <strong>${escapeHtml(ent.label)}</strong>
              </div>
            </label>
          `).join("")}
        </div>
      </div>
    `;
  }).join("");
}

function collectStaffTypeSettings() {
  const result = {};
  for (const type of EMPLOYMENT_TYPES) {
    result[type] = {};
    for (const ent of ENTITLEMENT_KEYS) {
      const cb = document.querySelector(
        `input[data-staff-type="${type}"][data-entitlement="${ent.key}"]`
      );
      result[type][ent.key] = cb ? cb.checked : false;
    }
  }
  return result;
}

document.getElementById("save-staff-types-btn").addEventListener("click", async () => {
  if (!ctx.isAdminOrHigher) return notice("Admins only", "warn");
  if (!currentOrgId) return;
  try {
    await saveOrgSettings({ employment_type_settings: collectStaffTypeSettings() });
    notice("Staff type settings saved", "success");
    flashStatus("staff-types-status");
  } catch (err) {
    notice(err.message || "Save failed", "error");
  }
});

/* ---------------------------------------------------------------- boot */

const jobsCtl      = makeController("jobs");
const tasksCtl     = makeController("tasks");
const deptCodesCtl = makeController("deptcodes");

/* ---------------------------------------------------------------- quick sync */

(function setupQuickSync() {
  const dropZone = document.getElementById("jobs-quick-sync-zone");
  const fileInput = document.getElementById("jobs-quick-file");
  const resultEl = document.getElementById("jobs-quick-result");
  if (!dropZone || !fileInput) return;

  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    if (e.dataTransfer.files[0]) runQuickSync(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) runQuickSync(fileInput.files[0]);
  });

  async function runQuickSync(file) {
    resultEl.style.display = "";
    resultEl.className = "mt-sm muted small";
    resultEl.textContent = "Reading file…";

    // Load saved mapping
    let mapping = {};
    try {
      const { data } = await sb.from("organisations")
        .select("jobs_import_map").eq("id", currentOrgId).maybeSingle();
      mapping = data?.jobs_import_map || {};
    } catch (err) {
      console.warn("jobs_import_map load failed:", err);
    }

    const codeCol = mapping.code_column || "jobid";
    const descCol = mapping.description_column || "title";
    const statusCol = mapping.status_column || "status";
    const statusMap = mapping.status_map || {};

    let rows;
    try {
      const buf = await file.arrayBuffer();
      const XLSX = await getXLSX();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    } catch (err) {
      resultEl.className = "mt-sm";
      resultEl.innerHTML = `<span style="color:var(--danger)">Failed to read file: ${escapeHtml(err.message)}</span>`;
      return;
    }

    if (!rows.length) {
      resultEl.textContent = "File is empty.";
      return;
    }

    const headers = Object.keys(rows[0]);
    if (!headers.includes(codeCol)) {
      resultEl.className = "mt-sm";
      resultEl.innerHTML = `<span style="color:var(--danger)">Column "${escapeHtml(codeCol)}" not found. Found: ${escapeHtml(headers.join(", "))}. Check your saved column mapping.</span>`;
      return;
    }

    resultEl.textContent = `Syncing ${rows.length} jobs…`;

    function resolveStatus(raw) {
      const trimmed = String(raw || "").trim();
      if (statusMap[trimmed]) return statusMap[trimmed];
      const upper = trimmed.replace(/\*/g, "").toUpperCase();
      if (JOB_STATUSES.includes(upper)) return upper;
      if (upper.startsWith("COMP")) return "COMPLETED";
      if (upper.startsWith("DISP") || upper === "DSPCH") return "DISPATCHED";
      if (upper.startsWith("INV")) return "INVOICED";
      return "ACTIVE";
    }

    const deduped = new Map();
    for (const r of rows) {
      const code = String(r[codeCol] || "").trim();
      if (!code) continue;
      deduped.set(code, {
        organisation_id: currentOrgId,
        job_code: code,
        description: descCol && r[descCol] ? String(r[descCol]).trim() : null,
        status: statusCol && r[statusCol] ? resolveStatus(r[statusCol]) : "ACTIVE",
        source: "import",
      });
    }

    const allRows = [...deduped.values()];
    const BATCH = 500;
    let imported = 0;
    let errors = 0;

    for (let i = 0; i < allRows.length; i += BATCH) {
      const batch = allRows.slice(i, i + BATCH);
      try {
        const { error } = await sb.from("jobs").upsert(batch, { onConflict: "organisation_id,job_code" });
        if (error) throw error;
        imported += batch.length;
      } catch (err) {
        console.error("Batch error", err);
        errors += batch.length;
      }
      resultEl.textContent = `Syncing… ${imported + errors} / ${allRows.length}`;
    }

    resultEl.className = "mt-sm";
    if (errors) {
      resultEl.innerHTML = `<span style="color:var(--warning)">Synced ${imported} jobs, ${errors} failed.</span>`;
    } else {
      resultEl.innerHTML = `<span style="color:var(--success)">Synced ${imported} jobs successfully.</span>`;
    }

    fileInput.value = "";
    jobsCtl.load();
  }
})();

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

// ---------------------------------------------------------------------------
// Xero Payroll integration — admin Settings card. Tokens live in the Worker;
// this page only reads sanitised status (tenant name, last refresh, errors)
// via the xero_connection_status() RPC and triggers connect/disconnect.
// ---------------------------------------------------------------------------

async function loadXeroStatus() {
  if (!currentOrgId) return;
  const statusEl = document.getElementById("xero-status");
  const connectBtn = document.getElementById("xero-connect-btn");
  const disconnectBtn = document.getElementById("xero-disconnect-btn");
  if (!statusEl) return;

  try {
    const { data, error } = await sb.rpc("xero_connection_status", { p_org_id: currentOrgId });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : null;

    const tabBtn = document.getElementById("tab-btn-xero");

    if (!row) {
      statusEl.textContent = "Not connected.";
      connectBtn.textContent = "Connect Xero";
      disconnectBtn.style.display = "none";
      if (tabBtn) tabBtn.style.display = "none";
      return;
    }

    const when = row.connected_at ? new Date(row.connected_at).toLocaleString() : "unknown";
    const lastRefresh = row.last_refreshed_at
      ? new Date(row.last_refreshed_at).toLocaleString()
      : "never";
    statusEl.innerHTML = `
      Connected to <strong>${escapeHtml(row.tenant_name || row.tenant_id)}</strong>
      by ${escapeHtml(row.connected_by_name || "—")} on ${escapeHtml(when)}.
      <br>Last token refresh: ${escapeHtml(lastRefresh)}.
      ${row.last_error ? `<br><span style="color:#c00">Last error: ${escapeHtml(row.last_error)}</span>` : ""}
    `;
    connectBtn.textContent = "Reconnect";
    disconnectBtn.style.display = "";
    if (tabBtn) tabBtn.style.display = "";
  } catch (err) {
    statusEl.textContent = err.message || "Failed to load Xero status";
  }
}

// ---------------------------------------------------------------------------
// Xero Mapping tab — employees + leave types
// ---------------------------------------------------------------------------

// Local copies of the most recent fetch, used to compute saves.
let _xeroEmployees = [];   // [{id, firstName, lastName, email}]
let _xeroLeaveTypes = [];  // [{id, name}]
let _ptlUsers = [];        // [{id, name, xero_employee_id}]
let _ptlLeaveJobs = [];    // [{id, code, description, xero_leave_type_id}] — jobs with is_leave=true

async function loadXeroMapping() {
  if (!currentOrgId) return;
  const empBody = document.getElementById("xero-employees-body");
  const ltBody = document.getElementById("xero-leavetypes-body");
  empBody.innerHTML = `<tr><td colspan="3" class="muted small" style="text-align:center">Loading…</td></tr>`;
  ltBody.innerHTML = `<tr><td colspan="3" class="muted small" style="text-align:center">Loading…</td></tr>`;

  // Fetch each half independently so one failure doesn't blank the other.
  const empPromise = (async () => {
    const usersResp = await sb.from("users")
      .select("id, name, xero_employee_id")
      .eq("organisation_id", currentOrgId)
      .eq("active", true)
      .order("name");
    if (usersResp.error) throw usersResp.error;
    _ptlUsers = usersResp.data || [];
    _xeroEmployees = await xeroApi("/xero/api/employees");
    renderXeroEmployeesTable();
  })().catch((err) => {
    empBody.innerHTML = `<tr><td colspan="3" class="muted small" style="color:#c00">${escapeHtml(err.message || "Failed to load")}</td></tr>`;
  });

  const ltPromise = (async () => {
    const jobsResp = await sb.from("jobs")
      .select("id, code, description, xero_leave_type_id")
      .eq("organisation_id", currentOrgId)
      .eq("is_leave", true)
      .order("code");
    if (jobsResp.error) throw jobsResp.error;
    _ptlLeaveJobs = jobsResp.data || [];
    _xeroLeaveTypes = await xeroApi("/xero/api/leave-types");
    renderXeroLeaveTypesTable();
  })().catch((err) => {
    ltBody.innerHTML = `<tr><td colspan="3" class="muted small" style="color:#c00">${escapeHtml(err.message || "Failed to load")}</td></tr>`;
  });

  await Promise.all([empPromise, ltPromise]);
}

async function xeroApi(path) {
  const { data: { session } } = await sb.auth.getSession();
  const jwt = session?.access_token;
  if (!jwt) throw new Error("Not signed in");
  const url = `${path}?org_id=${currentOrgId}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` } });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
  return json;
}

function xeroEmpLabel(e) {
  return `${e.firstName || ""} ${e.lastName || ""}`.trim() || e.id;
}

function renderXeroEmployeesTable() {
  const body = document.getElementById("xero-employees-body");
  if (_ptlUsers.length === 0) {
    body.innerHTML = `<tr><td colspan="3" class="muted small">No active users in this org.</td></tr>`;
    return;
  }
  const options = ['<option value="">— not mapped —</option>']
    .concat(_xeroEmployees.map((e) =>
      `<option value="${escapeHtml(e.id)}">${escapeHtml(xeroEmpLabel(e))}</option>`
    ))
    .join("");

  body.innerHTML = _ptlUsers.map((u) => {
    const sel = u.xero_employee_id || "";
    const mapped = _xeroEmployees.find((e) => e.id === sel);
    const status = !sel
      ? `<span class="muted small">unmapped</span>`
      : mapped
        ? `<span style="color:#080" class="small">linked</span>`
        : `<span style="color:#c00" class="small">stale id</span>`;
    return `
      <tr>
        <td>${escapeHtml(u.name)}</td>
        <td>
          <select data-user-id="${u.id}" class="xero-emp-select" style="width:100%">
            ${options.replace(`value="${escapeHtml(sel)}"`, `value="${escapeHtml(sel)}" selected`)}
          </select>
        </td>
        <td>${status}</td>
      </tr>
    `;
  }).join("");
}

function leaveJobLabel(j) {
  return j.description ? `${j.code} — ${j.description}` : j.code;
}

function renderXeroLeaveTypesTable() {
  const body = document.getElementById("xero-leavetypes-body");
  if (_ptlLeaveJobs.length === 0) {
    body.innerHTML = `<tr><td colspan="3" class="muted small">No jobs flagged "Leave". Tick the Leave checkbox on a job in the Jobs tab to make it mappable.</td></tr>`;
    return;
  }
  const options = ['<option value="">— not mapped —</option>']
    .concat(_xeroLeaveTypes.map((t) =>
      `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`
    ))
    .join("");

  body.innerHTML = _ptlLeaveJobs.map((j) => {
    const sel = j.xero_leave_type_id || "";
    const mapped = _xeroLeaveTypes.find((x) => x.id === sel);
    const status = !sel
      ? `<span class="muted small">unmapped</span>`
      : mapped
        ? `<span style="color:#080" class="small">linked</span>`
        : `<span style="color:#c00" class="small">stale id</span>`;
    return `
      <tr>
        <td>${escapeHtml(leaveJobLabel(j))}</td>
        <td>
          <select data-job-id="${j.id}" class="xero-lt-select" style="width:100%">
            ${options.replace(`value="${escapeHtml(sel)}"`, `value="${escapeHtml(sel)}" selected`)}
          </select>
        </td>
        <td>${status}</td>
      </tr>
    `;
  }).join("");
}

function normaliseName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
}

function autoMatchEmployees() {
  const byName = new Map();
  for (const e of _xeroEmployees) {
    byName.set(normaliseName(xeroEmpLabel(e)), e.id);
  }
  let matched = 0;
  for (const sel of document.querySelectorAll(".xero-emp-select")) {
    if (sel.value) continue;
    const userId = Number(sel.dataset.userId);
    const u = _ptlUsers.find((x) => x.id === userId);
    if (!u) continue;
    const candidate = byName.get(normaliseName(u.name));
    if (candidate) {
      sel.value = candidate;
      matched++;
    }
  }
  notice(`Matched ${matched} employee${matched === 1 ? "" : "s"} by name. Click Save to persist.`, "success");
}

function autoMatchLeaveTypes() {
  const byName = new Map();
  for (const t of _xeroLeaveTypes) {
    byName.set(normaliseName(t.name), t.id);
  }
  let matched = 0;
  for (const sel of document.querySelectorAll(".xero-lt-select")) {
    if (sel.value) continue;
    const jobId = Number(sel.dataset.jobId);
    const j = _ptlLeaveJobs.find((x) => x.id === jobId);
    if (!j) continue;
    // Try matching the job description first (e.g. "Annual Leave"), then
    // fall back to the code. Leave jobs tend to have human names in the
    // description and short codes like "AL".
    const candidate =
      byName.get(normaliseName(j.description)) ||
      byName.get(normaliseName(j.code));
    if (candidate) {
      sel.value = candidate;
      matched++;
    }
  }
  notice(`Matched ${matched} leave job${matched === 1 ? "" : "s"} by name. Click Save to persist.`, "success");
}

async function saveEmployeeMappings() {
  const status = document.getElementById("xero-employees-status");
  status.textContent = "Saving…";
  let saved = 0, errors = 0;
  for (const sel of document.querySelectorAll(".xero-emp-select")) {
    const userId = Number(sel.dataset.userId);
    const original = _ptlUsers.find((u) => u.id === userId)?.xero_employee_id || "";
    if (sel.value === original) continue;
    try {
      const { error } = await sb.rpc("xero_set_employee_mapping", {
        p_user_id: userId,
        p_xero_employee_id: sel.value || null,
      });
      if (error) throw error;
      saved++;
    } catch (err) {
      errors++;
      console.error("Mapping save failed for user", userId, err);
    }
  }
  status.textContent = errors ? `Saved ${saved}, ${errors} failed.` : `Saved ${saved}.`;
  notice(errors ? `${errors} mapping(s) failed — see console` : `Saved ${saved} mapping(s)`, errors ? "error" : "success");
  await loadXeroMapping();
}

async function saveLeaveTypeMappings() {
  const status = document.getElementById("xero-leavetypes-status");
  status.textContent = "Saving…";
  let saved = 0, errors = 0;
  for (const sel of document.querySelectorAll(".xero-lt-select")) {
    const jobId = Number(sel.dataset.jobId);
    const original = _ptlLeaveJobs.find((j) => j.id === jobId)?.xero_leave_type_id || "";
    if (sel.value === original) continue;
    try {
      const { error } = await sb.rpc("xero_set_job_leave_type_mapping", {
        p_job_id: jobId,
        p_xero_leave_type_id: sel.value || null,
      });
      if (error) throw error;
      saved++;
    } catch (err) {
      errors++;
      console.error("Mapping save failed for job", jobId, err);
    }
  }
  status.textContent = errors ? `Saved ${saved}, ${errors} failed.` : `Saved ${saved}.`;
  notice(errors ? `${errors} mapping(s) failed — see console` : `Saved ${saved} mapping(s)`, errors ? "error" : "success");
  await loadXeroMapping();
}

document.getElementById("xero-employees-automatch")?.addEventListener("click", autoMatchEmployees);
document.getElementById("xero-leavetypes-automatch")?.addEventListener("click", autoMatchLeaveTypes);
document.getElementById("xero-employees-save")?.addEventListener("click", saveEmployeeMappings);
document.getElementById("xero-leavetypes-save")?.addEventListener("click", saveLeaveTypeMappings);
document.getElementById("xero-employees-refresh")?.addEventListener("click", loadXeroMapping);

async function connectXero() {
  if (!currentOrgId) return notice("No organisation selected", "warn");
  const action = document.getElementById("xero-action-status");
  action.textContent = "Redirecting to Xero…";
  try {
    const { data: { session } } = await sb.auth.getSession();
    const jwt = session?.access_token;
    if (!jwt) throw new Error("Not signed in");

    const resp = await fetch("/xero/connect", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ org_id: currentOrgId }),
    });
    const json = await resp.json();
    if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
    window.location.href = json.authorize_url;
  } catch (err) {
    action.textContent = "";
    notice(err.message || "Could not start Xero connection", "error");
  }
}

async function disconnectXero() {
  if (!currentOrgId) return;
  const ok = await confirmDialog({
    title: "Disconnect Xero?",
    message: "Future leave requests will not file to Xero until you reconnect. Existing approved leave already in Xero is unaffected.",
    confirmText: "Disconnect",
  });
  if (!ok) return;

  const action = document.getElementById("xero-action-status");
  action.textContent = "Disconnecting…";
  try {
    const { error } = await sb.rpc("xero_disconnect", { p_org_id: currentOrgId });
    if (error) throw error;
    action.textContent = "Disconnected.";
    notice("Xero disconnected", "success");
    await loadXeroStatus();
  } catch (err) {
    action.textContent = "";
    notice(err.message || "Disconnect failed", "error");
  }
}

document.getElementById("xero-connect-btn")?.addEventListener("click", connectXero);
document.getElementById("xero-disconnect-btn")?.addEventListener("click", disconnectXero);

// Banner on return from the OAuth callback. The Worker redirects here with
// ?xero=connected on success; strip the query param so a refresh doesn't
// re-trigger the notice.
(function checkXeroReturn() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("xero") === "connected") {
    notice("Xero connected successfully", "success");
    params.delete("xero");
    const qs = params.toString();
    history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
  }
})();

// ---------------------------------------------------------------------------
// Leave Job Mapping (Settings tab) — links each is_leave job in
// public.jobs to one of the org's seeded leave_types via
// set_job_leave_type_mapping. Same shape as the Xero mapping above
// but pointed at the local table.
// ---------------------------------------------------------------------------

let _leaveJobs = [];   // [{id, code, description, leave_type_id}]
let _leaveTypes = [];  // [{id, code, name}]

async function loadLeaveJobMapping() {
  if (!currentOrgId) return;
  const body = document.getElementById("leave-job-body");
  if (!body) return;
  body.innerHTML = `<tr><td colspan="3" class="muted small" style="text-align:center">Loading…</td></tr>`;
  try {
    const [jobsResp, typesResp] = await Promise.all([
      sb.from("jobs")
        .select("id, job_code, description, leave_type_id")
        .eq("organisation_id", currentOrgId)
        .eq("is_leave", true)
        .order("job_code"),
      sb.from("leave_types")
        .select("id, code, name")
        .eq("organisation_id", currentOrgId)
        .eq("active", true)
        .order("sort_order"),
    ]);
    if (jobsResp.error) throw jobsResp.error;
    if (typesResp.error) throw typesResp.error;
    _leaveJobs = jobsResp.data || [];
    _leaveTypes = typesResp.data || [];
    renderLeaveJobTable();
  } catch (err) {
    body.innerHTML = `<tr><td colspan="3" class="muted small" style="color:#c00">${escapeHtml(err.message || "Failed to load")}</td></tr>`;
  }
}

function leaveJobLabel(j) {
  return j.description ? `${j.job_code} — ${j.description}` : j.job_code;
}

function renderLeaveJobTable() {
  const body = document.getElementById("leave-job-body");
  if (!body) return;
  if (_leaveJobs.length === 0) {
    body.innerHTML = `<tr><td colspan="3" class="muted small">No jobs flagged "Leave". Tick the Leave box on a job in the Jobs tab to make it mappable.</td></tr>`;
    return;
  }
  if (_leaveTypes.length === 0) {
    body.innerHTML = `<tr><td colspan="3" class="muted small">No leave types seeded for this org. Run seed_default_leave_types in Supabase or apply migration 126.</td></tr>`;
    return;
  }

  const options = ['<option value="">— not mapped —</option>']
    .concat(_leaveTypes.map((t) =>
      `<option value="${escapeHtml(String(t.id))}">${escapeHtml(t.name)}</option>`
    ))
    .join("");

  body.innerHTML = _leaveJobs.map((j) => {
    const sel = j.leave_type_id != null ? String(j.leave_type_id) : "";
    const mapped = _leaveTypes.find((t) => String(t.id) === sel);
    const status = !sel
      ? `<span class="muted small">unmapped</span>`
      : mapped
        ? `<span style="color:#080" class="small">linked to ${escapeHtml(mapped.name)}</span>`
        : `<span style="color:#c00" class="small">stale id</span>`;
    return `
      <tr>
        <td>${escapeHtml(leaveJobLabel(j))}</td>
        <td>
          <select data-job-id="${j.id}" class="leave-job-select" style="width:100%">
            ${options.replace(`value="${escapeHtml(sel)}"`, `value="${escapeHtml(sel)}" selected`)}
          </select>
        </td>
        <td>${status}</td>
      </tr>
    `;
  }).join("");
}

function normaliseLeaveName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
}

function autoMatchLeaveJobs() {
  const byName = new Map();
  const byCode = new Map();
  for (const t of _leaveTypes) {
    byName.set(normaliseLeaveName(t.name), t.id);
    byCode.set(normaliseLeaveName(t.code), t.id);
  }
  let matched = 0;
  for (const sel of document.querySelectorAll(".leave-job-select")) {
    if (sel.value) continue;
    const jobId = Number(sel.dataset.jobId);
    const j = _leaveJobs.find((x) => x.id === jobId);
    if (!j) continue;
    const candidate =
      byName.get(normaliseLeaveName(j.description)) ||
      byCode.get(normaliseLeaveName(j.description)) ||
      byName.get(normaliseLeaveName(j.job_code)) ||
      byCode.get(normaliseLeaveName(j.job_code));
    if (candidate) {
      sel.value = String(candidate);
      matched++;
    }
  }
  notice(`Matched ${matched} job${matched === 1 ? "" : "s"} by name/code. Click Save to persist.`, "success");
}

async function saveLeaveJobMappings() {
  const status = document.getElementById("leave-job-status");
  status.textContent = "Saving…";
  let saved = 0, errors = 0;
  for (const sel of document.querySelectorAll(".leave-job-select")) {
    const jobId = Number(sel.dataset.jobId);
    const original = (_leaveJobs.find((j) => j.id === jobId)?.leave_type_id) || "";
    const next = sel.value || null;
    const same = (String(original || "") === String(next || ""));
    if (same) continue;
    try {
      const { error } = await sb.rpc("set_job_leave_type_mapping", {
        p_job_id: jobId,
        p_leave_type_id: next ? Number(next) : null,
      });
      if (error) throw error;
      saved++;
    } catch (err) {
      errors++;
      console.error("Leave-job mapping save failed for job", jobId, err);
    }
  }
  status.textContent = errors ? `Saved ${saved}, ${errors} failed.` : `Saved ${saved}.`;
  notice(errors ? `${errors} mapping(s) failed — see console` : `Saved ${saved} mapping(s)`, errors ? "error" : "success");
  await loadLeaveJobMapping();
}

document.getElementById("leave-job-automatch")?.addEventListener("click", autoMatchLeaveJobs);
document.getElementById("leave-job-save")?.addEventListener("click", saveLeaveJobMappings);

function reloadAll() {
  jobsCtl.load();
  tasksCtl.load();
  deptCodesCtl.load();
}

reloadAll();
