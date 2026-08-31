// bell.js — the cross-module notification bell (public.notifications, hitlist
// migration 005). Ported from ptl-hitlist's canonical public/js/bell.js.
// PORTABLE BY DESIGN there: self-injected styles, session-guarded polling,
// self-REMOVES when the backing migration isn't applied. Timeium is a
// DIFFERENT lineage (its shared.js builds markup via innerHTML strings, no
// el()/clear() pair, and its Supabase singleton is getSupabase() not
// getClient()) — so only the two imports are adapted: getSupabase is
// aliased to getClient, and a tiny local el/clear shim is inlined below
// instead of importing shared.js. Do not add shared.js/app.css dependencies
// here — keep this copy-paste portable like the original.
import { getSupabase as getClient } from './supabase-client.js';

// Local DOM helpers — not exported, kept minimal, mirror ptl-hitlist's
// util.js just enough for this component.
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

const POLL_MS = 2 * 60 * 1000; // count poll — cheap RPC, but still be polite
const LIST_LIMIT = 30;

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
.ntf-wrap { position: relative; display: inline-flex; }
.ntf-btn {
  position: relative; display: inline-flex; align-items: center; justify-content: center;
  width: 34px; height: 34px; min-height: 0; padding: 0; border-radius: 50%;
  background: none; border: none; color: var(--text-muted, #667085); cursor: pointer;
  box-shadow: none;
}
.ntf-btn:hover { background: var(--surface-alt, #eef0f3); color: var(--text, #111); transform: none; box-shadow: none; }
.ntf-badge {
  position: absolute; top: 1px; right: 0;
  min-width: 15px; height: 15px; padding: 0 4px; border-radius: 999px;
  background: var(--danger, #b3261e); color: #fff;
  font-size: 10px; font-weight: 700; line-height: 15px; text-align: center;
}
.ntf-menu {
  position: absolute; top: calc(100% + 8px); right: 0; z-index: 60;
  width: min(92vw, 360px); max-height: 70vh; overflow-y: auto;
  background: var(--surface, #fff); color: var(--text, #111);
  border: 1px solid var(--border, #d9dee5); border-radius: 12px;
  box-shadow: var(--shadow, 0 8px 24px rgba(0,0,0,.12));
  display: none;
}
.ntf-wrap.open .ntf-menu { display: block; }
.ntf-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px; border-bottom: 1px solid var(--border, #d9dee5);
  font-size: 13px; font-weight: 700;
}
.ntf-mark {
  appearance: none; background: none; border: 0; padding: 0; cursor: pointer;
  font: inherit; font-size: 11.5px; font-weight: 400;
  color: var(--text-muted, #667085); text-decoration: underline; min-height: 0; box-shadow: none;
}
.ntf-mark:hover { color: var(--text, #111); }
.ntf-item {
  display: block; width: 100%; text-align: left; background: none; border: 0;
  border-bottom: 1px solid var(--border, #d9dee5); padding: 10px 14px; cursor: pointer;
  min-height: 0; box-shadow: none; border-radius: 0;
}
.ntf-item:last-child { border-bottom: 0; }
.ntf-item:hover { background: var(--surface-alt, #f4f6f8); transform: none; box-shadow: none; }
.ntf-title { font-size: 13px; color: var(--text, #111); }
.ntf-item.unread .ntf-title { font-weight: 700; }
.ntf-item.unread .ntf-title::before {
  content: ''; display: inline-block; width: 7px; height: 7px; border-radius: 50%;
  background: var(--danger, #b3261e); margin-right: 7px; vertical-align: 1px;
}
.ntf-body { font-size: 12px; color: var(--text-muted, #667085); margin-top: 2px;
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.ntf-meta { font-size: 11px; color: var(--text-muted, #667085); margin-top: 3px; }
.ntf-empty { padding: 18px 14px; font-size: 12.5px; color: var(--text-muted, #667085); }
`;
  document.head.append(el('style', {}, css));
}

const BELL_SVG = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';

function relTime(iso) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

// supported: null = unprobed, false = 005 missing (bell hides, polling stops).
let supported = null;

async function rpc(name, args) {
  const sb = await getClient();
  // Session guard — a lapsed tab must not poll as anon (the 42501 lesson).
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return null;
  const { data, error } = await sb.rpc(name, args);
  if (error) {
    if (error.code === 'PGRST202') { supported = false; }
    throw error;
  }
  return data;
}

// Mount into any topbar. Renders nothing visible until the first count
// arrives; removes itself for good if the infrastructure isn't there.
export function notificationBell() {
  injectStyles();
  const badge = el('span', { class: 'ntf-badge', hidden: 'hidden' });
  const list = el('div', {});
  const btn = el('button', {
    class: 'ntf-btn', type: 'button',
    'aria-label': 'Notifications', 'aria-haspopup': 'true', 'aria-expanded': 'false',
    html: BELL_SVG,
  });
  btn.append(badge);
  const menu = el('div', { class: 'ntf-menu', role: 'menu' });
  const wrap = el('div', { class: 'ntf-wrap' }, btn, menu);

  const setOpen = (open) => {
    wrap.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
    if (open) fillList();
  };
  btn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(!wrap.classList.contains('open')); });
  const onDocClick = (e) => {
    if (!wrap.isConnected) { document.removeEventListener('click', onDocClick); return; }
    if (!wrap.contains(e.target)) setOpen(false);
  };
  const onDocKey = (e) => {
    if (!wrap.isConnected) { document.removeEventListener('keydown', onDocKey); return; }
    if (e.key === 'Escape') setOpen(false);
  };
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onDocKey);

  async function refreshCount() {
    if (supported === false) { wrap.remove(); return; }
    try {
      const n = await rpc('my_notification_count');
      if (n == null) return;
      const count = Number(n) || 0;
      if (count > 0) {
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.removeAttribute('hidden');
      } else {
        badge.setAttribute('hidden', 'hidden');
      }
    } catch (_) {
      if (supported === false) wrap.remove(); // 005 not applied — no bell at all
    }
  }

  async function fillList() {
    clear(menu);
    menu.append(
      el('div', { class: 'ntf-head' },
        'Notifications',
        el('button', {
          class: 'ntf-mark', type: 'button',
          onclick: async (e) => {
            e.stopPropagation();
            try { await rpc('mark_notifications_read', { p_ids: null }); } catch (_) { /* stays unread */ }
            refreshCount(); fillList();
          },
        }, 'Mark all read')),
      list);
    clear(list);
    list.append(el('div', { class: 'ntf-empty' }, 'Loading…'));
    let rows;
    try { rows = await rpc('my_notifications', { p_limit: LIST_LIMIT }); }
    catch (_) { rows = null; }
    clear(list);
    if (!rows || !rows.length) {
      list.append(el('div', { class: 'ntf-empty' },
        rows ? 'You’re all caught up.' : 'Notifications are unavailable right now.'));
      return;
    }
    for (const r of rows) {
      list.append(el('button', {
        class: 'ntf-item' + (r.read_at ? '' : ' unread'), type: 'button',
        onclick: async () => {
          try { if (!r.read_at) await rpc('mark_notifications_read', { p_ids: [r.id] }); }
          catch (_) { /* navigation still worth doing */ }
          if (r.link) location.href = r.link;
          else { refreshCount(); fillList(); }
        },
      },
        el('div', { class: 'ntf-title' }, r.title),
        r.body ? el('div', { class: 'ntf-body' }, r.body) : null,
        el('div', { class: 'ntf-meta' }, `${r.module_key} · ${relTime(r.created_at)}`)));
    }
  }

  refreshCount();
  const timer = setInterval(() => {
    if (!wrap.isConnected) { clearInterval(timer); return; }
    if (document.hidden) return;
    refreshCount();
  }, POLL_MS);
  document.addEventListener('visibilitychange', function onVis() {
    if (!wrap.isConnected) { document.removeEventListener('visibilitychange', onVis); return; }
    if (!document.hidden) refreshCount();
  });

  return wrap;
}
