// Temporium Jobs page.
//
// Three sub-tabs:
//   1. View all — sorted ACTIVE-first, with search + status filter + inline
//                 status edit / delete for admins.
//   2. Add      — manual entry (code, description, status).
//   3. Import   — Power Automate webhook setup: URL + anon key + org API
//                 key + column mapping + status-value mapping.

import { getSupabase, getConfig } from "/js/supabase-client.js";
import {
  notice,
  escapeHtml,
  renderTopbar,
  requireAdmin,
} from "/js/shared.js";

const sb  = await getSupabase();
const cfg = await getConfig();
const ctx = await requireAdmin(sb);
let currentOrgId = ctx.currentOrgId;

renderTopbar({
  session: ctx.session,
  isDeveloper: ctx.isDeveloper,
  adminRow: ctx.adminRow,
  orgs: ctx.orgs,
  currentOrgId,
  onOrgChange: (id) => {
    currentOrgId = id;
    localStorage.setItem("temporium-dev-org-id", String(id));
    reloadAll();
  },
  active: "jobs",
});

/* ---------------------------------------------------------------- state */

let jobs = [];
let filter = { search: "", status: "" };
let activeTab = "view";

const JOB_STATUSES = ["ACTIVE","PARTIAL","DISPATCHED","INVOICED","DEP","COMPLETED"];

/* ---------------------------------------------------------------- tabs */

document.querySelectorAll("[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-tab]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    activeTab = btn.dataset.tab;
    document.getElementById("tab-view").style.display   = activeTab === "view"   ? "" : "none";
    document.getElementById("tab-add").style.display    = activeTab === "add"    ? "" : "none";
    document.getElementById("tab-import").style.display = activeTab === "import" ? "" : "none";
    if (activeTab === "import") loadImportConfig();
  });
});

/* ---------------------------------------------------------------- filters */

document.getElementById("search-input").addEventListener("input", (e) => {
  filter.search = e.target.value.trim().toLowerCase();
  renderJobs();
});
document.getElementById("status-filter").addEventListener("change", (e) => {
  filter.status = e.target.value;
  renderJobs();
});

/* ---------------------------------------------------------------- load */

async function loadJobs() {
  if (!currentOrgId) return;
  try {
    const { data, error } = await sb
      .from("jobs")
      .select("id, job_code, description, status, source, last_synced_at")
      .eq("organisation_id", currentOrgId)
      .order("status", { ascending: true }) // Postgres orders by text; ACTIVE sorts first alphabetically by luck (A<C<D<I<P), not reliable — we re-sort client-side below.
      .order("job_code", { ascending: true });
    if (error) throw error;
    jobs = data || [];
    // Stable ACTIVE-first sort, then by code.
    jobs.sort((a, b) => {
      const aActive = a.status === "ACTIVE" ? 0 : 1;
      const bActive = b.status === "ACTIVE" ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return a.job_code.localeCompare(b.job_code);
    });
    renderJobs();
  } catch (err) {
    console.error(err);
    notice(err.message || "Failed to load jobs", "error");
  }
}

/* ---------------------------------------------------------------- render */

function renderJobs() {
  const body = document.getElementById("jobs-body");
  const rows = jobs.filter((j) => {
    if (filter.status && j.status !== filter.status) return false;
    if (!filter.search) return true;
    const q = filter.search;
    return (
      j.job_code.toLowerCase().includes(q) ||
      (j.description || "").toLowerCase().includes(q)
    );
  });

  document.getElementById("jobs-summary").textContent =
    `${rows.length} shown · ${jobs.length} total`;

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="6" class="muted small" style="text-align:center">No jobs match.</td></tr>`;
    return;
  }

  body.innerHTML = rows.map((j) => `
    <tr data-id="${j.id}">
      <td><strong>${escapeHtml(j.job_code)}</strong></td>
      <td>${escapeHtml(j.description || "")}</td>
      <td>
        <select class="status-cell" ${ctx.isAdminOrHigher ? "" : "disabled"}>
          ${JOB_STATUSES.map((s) =>
            `<option value="${s}"${s === j.status ? " selected" : ""}>${s}</option>`
          ).join("")}
        </select>
      </td>
      <td><span class="small muted">${escapeHtml(j.source || "")}</span></td>
      <td class="small muted">${j.last_synced_at ? new Date(j.last_synced_at).toLocaleString() : ""}</td>
      <td>
        ${ctx.isAdminOrHigher
          ? `<button class="ghost small delete-btn" title="Delete">✕</button>`
          : ""}
      </td>
    </tr>
  `).join("");

  body.querySelectorAll(".status-cell").forEach((sel) => {
    sel.addEventListener("change", async (e) => {
      const tr = e.target.closest("tr");
      const id = Number(tr.dataset.id);
      const newStatus = e.target.value;
      try {
        const { error } = await sb.from("jobs").update({ status: newStatus }).eq("id", id);
        if (error) throw error;
        const j = jobs.find((x) => x.id === id);
        if (j) j.status = newStatus;
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
      const j = jobs.find((x) => x.id === id);
      if (!j) return;
      if (!confirm(`Delete job ${j.job_code}?`)) return;
      try {
        const { error } = await sb.from("jobs").delete().eq("id", id);
        if (error) throw error;
        jobs = jobs.filter((x) => x.id !== id);
        renderJobs();
        notice("Deleted", "success");
      } catch (err) {
        notice(err.message || "Delete failed", "error");
      }
    });
  });
}

/* ---------------------------------------------------------------- add */

document.getElementById("add-job-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!ctx.isAdminOrHigher) return notice("Admins only", "warn");
  const code = document.getElementById("aj-code").value.trim();
  const desc = document.getElementById("aj-desc").value.trim() || null;
  const status = document.getElementById("aj-status").value;
  if (!code) return;

  try {
    const { error } = await sb
      .from("jobs")
      .upsert(
        {
          organisation_id: currentOrgId,
          job_code: code,
          description: desc,
          status,
          source: "manual",
        },
        { onConflict: "organisation_id,job_code" }
      );
    if (error) throw error;
    notice(`Saved ${code}`, "success");
    document.getElementById("add-job-form").reset();
    await loadJobs();
  } catch (err) {
    notice(err.message || "Save failed", "error");
  }
});

/* ---------------------------------------------------------------- import config */

function webhookUrl() {
  return `${cfg.supabaseUrl}/rest/v1/rpc/ingest_jobs_via_webhook`;
}

async function loadImportConfig() {
  document.getElementById("webhook-url").value = webhookUrl();
  document.getElementById("anon-key").value    = cfg.supabaseAnonKey;

  try {
    const { data, error } = await sb
      .from("organisations")
      .select("jobs_webhook_key, jobs_import_map")
      .eq("id", currentOrgId)
      .maybeSingle();
    if (error) throw error;

    document.getElementById("api-key").value = data?.jobs_webhook_key || "";

    const map = data?.jobs_import_map || {};
    document.getElementById("mp-code").value   = map.code_column        || "";
    document.getElementById("mp-desc").value   = map.description_column || "";
    document.getElementById("mp-status").value = map.status_column      || "";

    renderStatusMapRows(map.status_map || {});
  } catch (err) {
    notice(err.message || "Failed to load import config", "error");
  }
}

function renderStatusMapRows(statusMap) {
  const el = document.getElementById("status-map-rows");
  const rows = Object.entries(statusMap);
  if (!rows.length) rows.push(["", ""]);
  el.innerHTML = rows.map(([from, to]) => renderStatusRow(from, to)).join("");
}

function renderStatusRow(from, to) {
  return `
    <div class="row-flex mb-sm status-map-row" style="gap:8px">
      <input class="sm-from" placeholder="Source value (e.g. Active)" value="${escapeHtml(from)}" style="flex:1" />
      <span class="muted">→</span>
      <select class="sm-to" style="width:200px">
        ${JOB_STATUSES.map((s) =>
          `<option value="${s}"${s === to ? " selected" : ""}>${s}</option>`
        ).join("")}
      </select>
      <button type="button" class="ghost sm-del" title="Remove">✕</button>
    </div>
  `;
}

document.getElementById("add-status-row").addEventListener("click", () => {
  const el = document.getElementById("status-map-rows");
  el.insertAdjacentHTML("beforeend", renderStatusRow("", "ACTIVE"));
});

document.getElementById("status-map-rows").addEventListener("click", (e) => {
  if (e.target.classList.contains("sm-del")) {
    e.target.closest(".status-map-row").remove();
  }
});

document.getElementById("mapping-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!ctx.isAdminOrHigher) return notice("Admins only", "warn");

  const statusMap = {};
  document.querySelectorAll("#status-map-rows .status-map-row").forEach((row) => {
    const from = row.querySelector(".sm-from").value.trim();
    const to   = row.querySelector(".sm-to").value;
    if (from) statusMap[from] = to;
  });

  const mapping = {
    code_column:        document.getElementById("mp-code").value.trim(),
    description_column: document.getElementById("mp-desc").value.trim(),
    status_column:      document.getElementById("mp-status").value.trim(),
    status_map:         statusMap,
  };

  try {
    const { error } = await sb.rpc("save_import_mapping", {
      p_kind: "jobs",
      p_mapping: mapping,
      p_org_id: currentOrgId,
    });
    if (error) throw error;
    notice("Mapping saved", "success");
  } catch (err) {
    notice(err.message || "Save failed", "error");
  }
});

document.getElementById("rotate-key-btn").addEventListener("click", async () => {
  if (!ctx.isAdminOrHigher) return notice("Admins only", "warn");
  const existing = document.getElementById("api-key").value;
  if (existing && !confirm("Replace the existing key? Any flows using the old key will stop working until updated.")) return;
  try {
    const { data, error } = await sb.rpc("rotate_import_key", {
      p_kind: "jobs",
      p_org_id: currentOrgId,
    });
    if (error) throw error;
    document.getElementById("api-key").value = data;
    notice("New key generated", "success");
  } catch (err) {
    notice(err.message || "Failed to rotate key", "error");
  }
});

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

/* ---------------------------------------------------------------- boot */

function reloadAll() {
  loadJobs();
  if (activeTab === "import") loadImportConfig();
}

reloadAll();
