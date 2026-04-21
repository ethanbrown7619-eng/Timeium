// Temporium Tasks page.
// Mirror of /jobs.js — simpler status set (ACTIVE / COMPLETED only).

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
  active: "tasks",
});

let tasks = [];
let filter = { search: "", status: "" };
let activeTab = "view";

const TASK_STATUSES = ["ACTIVE", "COMPLETED"];

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
  renderTasks();
});
document.getElementById("status-filter").addEventListener("change", (e) => {
  filter.status = e.target.value;
  renderTasks();
});

/* ---------------------------------------------------------------- load */

async function loadTasks() {
  if (!currentOrgId) return;
  try {
    const { data, error } = await sb
      .from("tasks")
      .select("id, task_code, description, status, source, last_synced_at")
      .eq("organisation_id", currentOrgId)
      .order("task_code", { ascending: true });
    if (error) throw error;
    tasks = data || [];
    tasks.sort((a, b) => {
      const aActive = a.status === "ACTIVE" ? 0 : 1;
      const bActive = b.status === "ACTIVE" ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return a.task_code.localeCompare(b.task_code);
    });
    renderTasks();
  } catch (err) {
    console.error(err);
    notice(err.message || "Failed to load tasks", "error");
  }
}

/* ---------------------------------------------------------------- render */

function renderTasks() {
  const body = document.getElementById("tasks-body");
  const rows = tasks.filter((t) => {
    if (filter.status && t.status !== filter.status) return false;
    if (!filter.search) return true;
    const q = filter.search;
    return (
      t.task_code.toLowerCase().includes(q) ||
      (t.description || "").toLowerCase().includes(q)
    );
  });

  document.getElementById("tasks-summary").textContent =
    `${rows.length} shown · ${tasks.length} total`;

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="6" class="muted small" style="text-align:center">No tasks match.</td></tr>`;
    return;
  }

  body.innerHTML = rows.map((t) => `
    <tr data-id="${t.id}">
      <td><strong>${escapeHtml(t.task_code)}</strong></td>
      <td>${escapeHtml(t.description || "")}</td>
      <td>
        <select class="status-cell" ${ctx.isAdminOrHigher ? "" : "disabled"}>
          ${TASK_STATUSES.map((s) =>
            `<option value="${s}"${s === t.status ? " selected" : ""}>${s}</option>`
          ).join("")}
        </select>
      </td>
      <td><span class="small muted">${escapeHtml(t.source || "")}</span></td>
      <td class="small muted">${t.last_synced_at ? new Date(t.last_synced_at).toLocaleString() : ""}</td>
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
        const { error } = await sb.from("tasks").update({ status: newStatus }).eq("id", id);
        if (error) throw error;
        const t = tasks.find((x) => x.id === id);
        if (t) t.status = newStatus;
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
      const t = tasks.find((x) => x.id === id);
      if (!t) return;
      if (!confirm(`Delete task ${t.task_code}?`)) return;
      try {
        const { error } = await sb.from("tasks").delete().eq("id", id);
        if (error) throw error;
        tasks = tasks.filter((x) => x.id !== id);
        renderTasks();
        notice("Deleted", "success");
      } catch (err) {
        notice(err.message || "Delete failed", "error");
      }
    });
  });
}

/* ---------------------------------------------------------------- add */

document.getElementById("add-task-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!ctx.isAdminOrHigher) return notice("Admins only", "warn");
  const code = document.getElementById("at-code").value.trim();
  const desc = document.getElementById("at-desc").value.trim() || null;
  const status = document.getElementById("at-status").value;
  if (!code) return;

  try {
    const { error } = await sb
      .from("tasks")
      .upsert(
        {
          organisation_id: currentOrgId,
          task_code: code,
          description: desc,
          status,
          source: "manual",
        },
        { onConflict: "organisation_id,task_code" }
      );
    if (error) throw error;
    notice(`Saved ${code}`, "success");
    document.getElementById("add-task-form").reset();
    await loadTasks();
  } catch (err) {
    notice(err.message || "Save failed", "error");
  }
});

/* ---------------------------------------------------------------- import config */

function webhookUrl() {
  return `${cfg.supabaseUrl}/rest/v1/rpc/ingest_tasks_via_webhook`;
}

async function loadImportConfig() {
  document.getElementById("webhook-url").value = webhookUrl();
  document.getElementById("anon-key").value    = cfg.supabaseAnonKey;

  try {
    const { data, error } = await sb
      .from("organisations")
      .select("tasks_webhook_key, tasks_import_map")
      .eq("id", currentOrgId)
      .maybeSingle();
    if (error) throw error;

    document.getElementById("api-key").value = data?.tasks_webhook_key || "";
    const map = data?.tasks_import_map || {};
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
      <input class="sm-from" placeholder="Source value" value="${escapeHtml(from)}" style="flex:1" />
      <span class="muted">→</span>
      <select class="sm-to" style="width:200px">
        ${TASK_STATUSES.map((s) =>
          `<option value="${s}"${s === to ? " selected" : ""}>${s}</option>`
        ).join("")}
      </select>
      <button type="button" class="ghost sm-del" title="Remove">✕</button>
    </div>
  `;
}

document.getElementById("add-status-row").addEventListener("click", () => {
  document
    .getElementById("status-map-rows")
    .insertAdjacentHTML("beforeend", renderStatusRow("", "ACTIVE"));
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
      p_kind: "tasks",
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
      p_kind: "tasks",
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
  loadTasks();
  if (activeTab === "import") loadImportConfig();
}

reloadAll();
