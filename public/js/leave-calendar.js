// Leave calendar — the Calendar tab on the Leave page. A month grid of
// approved leave rendered as privacy-limited "Name — Leave" events from the
// org_leave_calendar RPC (migration 156): any org member may look, so the
// payload is only WHO is away and WHICH days — never the leave type, reason,
// hours, or review notes.
//
// The month-grid machinery (Monday-start fixed 6-week grid, per-month cache,
// neighbour prefetch, a token that drops stale fetches on rapid ‹ › nav) is
// ported from PTL-map's public/js/calendar-grid.js — the Map module owns the
// ERP calendar; keep the mechanics in sync with it. The same feed renders as
// the Leave sub-tab of Map's Calendar page.

import { escapeHtml } from "/js/shared.js";

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Monday-start 6-week grid containing the 1st of the view month.
function gridStart(y, m) {
  const first = new Date(y, m, 1);
  const offset = (first.getDay() + 6) % 7;
  return new Date(y, m, 1 - offset);
}

function gridEnd(y, m) {
  const start = gridStart(y, m);
  const end = new Date(start);
  end.setDate(start.getDate() + 41);
  return end;
}

// One RPC row covers a date RANGE; the grid wants per-day items. Expand each
// request into the days that fall inside the grid window, skipping Sat/Sun
// when the request skips weekends.
function expandDays(rows, fromIso, toIso) {
  const byDay = new Map(); // iso → [{ userId, name }]
  for (const r of rows || []) {
    const from = r.start_date > fromIso ? r.start_date : fromIso;
    const to = r.end_date < toIso ? r.end_date : toIso;
    for (let d = new Date(from + "T00:00:00"); ; d.setDate(d.getDate() + 1)) {
      const iso = isoDate(d);
      if (iso > to) break;
      const dow = d.getDay(); // 0=Sun, 6=Sat
      if (r.skip_weekends && (dow === 0 || dow === 6)) continue;
      if (!byDay.has(iso)) byDay.set(iso, []);
      byDay.get(iso).push({ userId: r.user_id, name: r.employee_name });
    }
  }
  return byDay;
}

function fmtDayTitle(iso) {
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
}

/**
 * Mount the leave calendar into `host`. Returns { load } — call load() the
 * first time the tab is shown (months cache for the page's life, so
 * re-showing the tab needs no reload).
 */
export function mountLeaveCalendar(host, sb, orgId) {
  const now = new Date();
  const state = { y: now.getFullYear(), m: now.getMonth() };
  const cache = new Map(); // 'y-m' → byDay Map
  let token = 0;

  async function fetchMonth(y, m) {
    const key = `${y}-${m}`;
    if (cache.has(key)) return cache.get(key);
    const fromIso = isoDate(gridStart(y, m));
    const toIso = isoDate(gridEnd(y, m));
    const { data, error } = await sb.rpc("org_leave_calendar", {
      p_org_id: orgId, p_from: fromIso, p_to: toIso,
    });
    if (error) throw error;
    const byDay = expandDays(data, fromIso, toIso);
    cache.set(key, byDay);
    return byDay;
  }

  function shiftMonth(delta) {
    state.m += delta;
    if (state.m < 0) { state.m = 11; state.y--; }
    if (state.m > 11) { state.m = 0; state.y++; }
    load();
  }

  function dayDialog(iso, people) {
    const dlg = document.createElement("dialog");
    dlg.className = "lc-dialog";
    dlg.innerHTML = `
      <div style="padding:20px;width:min(95vw,420px)">
        <h2 style="margin:0 0 4px">${escapeHtml(fmtDayTitle(iso))}</h2>
        <p class="muted small" style="margin:0 0 12px">${people.length} on leave</p>
        <div class="lc-dialog-list">
          ${people.map((p) => `
            <div class="lc-dialog-row">
              <span>${escapeHtml(p.name)}</span>
              <span class="muted small">Leave</span>
            </div>`).join("")}
        </div>
        <div class="row-flex mt-md" style="justify-content:flex-end">
          <button class="ghost lc-dialog-close">Close</button>
        </div>
      </div>`;
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener("close", () => dlg.remove());
    dlg.querySelector(".lc-dialog-close").addEventListener("click", () => dlg.close());
    document.body.append(dlg);
    dlg.showModal();
  }

  function paint(byDay, { loading = false } = {}) {
    const start = gridStart(state.y, state.m);
    const monthName = new Date(state.y, state.m, 1)
      .toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const todayIso = isoDate(new Date());

    let cells = "";
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const iso = isoDate(d);
      const inMonth = d.getMonth() === state.m;
      const dow = d.getDay();
      const people = byDay.get(iso) || [];
      const chips = people.slice(0, 3).map((p) =>
        `<span class="lc-ev" title="${escapeHtml(p.name)} — Leave">${escapeHtml(p.name)} — Leave</span>`
      );
      if (people.length > 3) chips.push(`<span class="lc-ev lc-more">+${people.length - 3} more</span>`);
      const clickable = people.length > 0;
      cells += `<div class="lc-cell${inMonth ? "" : " out"}${iso === todayIso ? " today" : ""}${dow === 0 || dow === 6 ? " weekend" : ""}${clickable ? " clickable" : ""}"
        data-iso="${iso}"${clickable ? ` role="button" tabindex="0"` : ""}>
        <div class="lc-daynum">${d.getDate()}</div>
        ${chips.join("")}
      </div>`;
    }

    host.innerHTML = `
      <div class="row-flex mb-md">
        <h2 style="margin:0">Leave calendar</h2>
        <div class="grow"></div>
        <button class="ghost small" id="lc-prev" aria-label="Previous month">‹</button>
        <span class="lc-month">${escapeHtml(monthName)}</span>
        <button class="ghost small" id="lc-next" aria-label="Next month">›</button>
        <button class="ghost small" id="lc-today">Today</button>
      </div>
      <p class="muted small" style="margin:0 0 12px">Approved leave across the organisation — names only.</p>
      <div class="lc-scroll">
        <div class="lc-grid${loading ? " lc-loading" : ""}">
          ${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<div class="lc-dow">${d}</div>`).join("")}
          ${cells}
        </div>
      </div>`;

    host.querySelector("#lc-prev").addEventListener("click", () => shiftMonth(-1));
    host.querySelector("#lc-next").addEventListener("click", () => shiftMonth(1));
    host.querySelector("#lc-today").addEventListener("click", () => {
      const t = new Date();
      state.y = t.getFullYear();
      state.m = t.getMonth();
      load();
    });
    for (const cell of host.querySelectorAll(".lc-cell.clickable")) {
      const open = () => dayDialog(cell.dataset.iso, byDay.get(cell.dataset.iso) || []);
      cell.addEventListener("click", open);
      cell.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      });
    }
  }

  async function load() {
    const tok = ++token;
    const cached = cache.get(`${state.y}-${state.m}`);
    paint(cached || new Map(), { loading: !cached });

    if (!cached) {
      let byDay = new Map();
      try {
        byDay = await fetchMonth(state.y, state.m);
      } catch (err) {
        console.warn("leave calendar load failed:", err);
      }
      if (tok !== token) return; // user already navigated on
      paint(byDay, { loading: false });
    }

    // Prefetch neighbours so ‹ › are instant next time (fire-and-forget).
    const prev = state.m === 0 ? [state.y - 1, 11] : [state.y, state.m - 1];
    const next = state.m === 11 ? [state.y + 1, 0] : [state.y, state.m + 1];
    fetchMonth(...prev).catch(() => {});
    fetchMonth(...next).catch(() => {});
  }

  return { load };
}
