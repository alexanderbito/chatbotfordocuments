/* =====================================================================
   BotClarify — shared front-end library
   ===================================================================== */

const LOCALE = 'en-US';

/**
 * The marketing site lives on its own domain, so links out of the app cannot be
 * relative. Kept in one place: changing the domain should be one edit, not a
 * search through every page.
 */
export const SITE_URL = 'https://botclarify.com';
export function locale() { return LOCALE; }

/**
 * Fill {placeholders} in a string. Not a translation layer — the app ships in
 * English only — just one place to keep interpolation readable at call sites.
 */
export function t(s, vars) {
  let out = String(s);
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(v);
  return out;
}

/**
 * The product prices and bills in USD. The optional currency argument exists
 * only so the admin console can render historical transactions that were
 * settled in another currency before the switch.
 */
export function money(amount, cur = 'USD') {
  const n = Number(amount || 0);
  if (cur !== 'USD') return `${n.toLocaleString(LOCALE)} ${cur}`;
  return `$${n.toLocaleString(LOCALE, { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

/* ---------- Session ---------- */
const TOKEN_KEY = 'botclarify_token';
const ORG_KEY = 'botclarify_org';

// One-time carry-over from the keys used before the product was renamed, so the
// rename does not sign everyone out. Safe to delete once no one is on an old
// session any more.
(function migrateLegacyKeys() {
  try {
    for (const [oldKey, newKey] of [['docbot_token', TOKEN_KEY], ['docbot_org', ORG_KEY]]) {
      const v = localStorage.getItem(oldKey);
      if (v && !localStorage.getItem(newKey)) localStorage.setItem(newKey, v);
      if (v) localStorage.removeItem(oldKey);
    }
  } catch { /* private mode: nothing to carry over */ }
})();

export const Session = {
  get token() { return localStorage.getItem(TOKEN_KEY); },
  set token(v) { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); },
  clear() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(ORG_KEY); },
  get orgId() { return localStorage.getItem(ORG_KEY); },
  set orgId(v) { v ? localStorage.setItem(ORG_KEY, v) : localStorage.removeItem(ORG_KEY); },
};

/* ---------- API calls ---------- */
export async function api(path, { method = 'GET', body, form, raw } = {}) {
  const headers = {};
  if (Session.token) headers.Authorization = `Bearer ${Session.token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }

  const res = await fetch(path, { method, headers, body: payload });
  if (res.status === 401) {
    Session.clear();
    if (!location.pathname.includes('login')) location.href = '/login.html?expired=1';
    throw new Error(t('Your session has expired'));
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data?.error || t('Error {code}', { code: res.status }));
  return raw ? text : data;
}

/**
 * Downloads a file from an authenticated endpoint.
 *
 * A plain <a href> cannot carry the Authorization header, so the bytes are
 * fetched, turned into a blob and handed to a temporary link. The filename
 * comes from Content-Disposition when the server sent one.
 */
export async function downloadFile(path, fallbackName = 'download') {
  const headers = {};
  if (Session.token) headers.Authorization = `Bearer ${Session.token}`;
  const res = await fetch(path, { headers });
  if (!res.ok) {
    let msg = `Error ${res.status}`;
    try { msg = (await res.json())?.error || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }

  const disposition = res.headers.get('Content-Disposition') || '';
  const match = /filename="?([^"]+)"?/.exec(disposition);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = match ? match[1] : fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick: Safari needs the URL to still exist when it
  // starts the download, so it cannot be released synchronously.
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ---------- Page guards ---------- */
export async function requireSession({ systemAdmin = false } = {}) {
  if (!Session.token) { location.href = '/login.html'; throw new Error('redirect'); }
  try {
    const me = await api('/auth/me');
    if (systemAdmin && !me.user.is_system_admin) { location.href = '/chat.html'; throw new Error('redirect'); }
    return me;
  } catch (err) {
    if (err.message !== 'redirect') { Session.clear(); location.href = '/login.html'; }
    throw err;
  }
}

export function logout() { Session.clear(); location.href = '/login.html'; }

/* ---------- Formatting ---------- */
export const fmt = {
  num: (n) => Number(n || 0).toLocaleString(locale()),
  money: (n) => money(n),
  mb: (n) => `${Number(n || 0).toLocaleString(locale(), { maximumFractionDigits: 1 })} MB`,
  bytes(b) {
    b = Number(b || 0);
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  },
  date(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric' });
  },
  dateTime(d) {
    if (!d) return '—';
    return new Date(d).toLocaleString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  },
  until(d) {
    if (!d) return '';
    const s = (new Date(d) - Date.now()) / 1000;
    if (s <= 0) return t('starting soon');
    if (s < 60) return t('in {n}s', { n: Math.ceil(s) });
    return t('in {n} min', { n: Math.ceil(s / 60) });
  },
  /** Time left, rendered as "2d 5h". */
  duration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    if (d > 0) return t('{d}d {h}h', { d, h });
    if (h > 0) return t('{h}h {m}m', { h, m });
    return t('{m}m', { m });
  },
  ago(d) {
    if (!d) return '—';
    const s = (Date.now() - new Date(d)) / 1000;
    if (s < 60) return t('just now');
    if (s < 3600) return t('{n} min ago', { n: Math.floor(s / 60) });
    if (s < 86400) return t('{n}h ago', { n: Math.floor(s / 3600) });
    if (s < 604800) return t('{n}d ago', { n: Math.floor(s / 86400) });
    return fmt.date(d);
  },
};

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function debounce(fn, ms = 350) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function initials(nameOrEmail = '?') {
  const s = String(nameOrEmail).trim();
  if (s.includes('@')) return s[0].toUpperCase();
  const parts = s.split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[parts.length - 1]?.[0] || '')).toUpperCase() || '?';
}

/* ---------- Display labels ---------- */
export const LABEL = {
  status: { ready: 'Ready', processing: 'Processing', ocr_processing: 'Running OCR', ocr_retry: 'Retry pending', failed: 'Failed', active: 'Active', suspended: 'Suspended', invited: 'Invited', disabled: 'Disabled' },
  method: { text: 'Text', ocr: 'OCR', mixed: 'Mixed' },
  role: { admin: 'Admin', member: 'Member' },
  billing: { trial: 'Trial', paid: 'Paid', overdue: 'Overdue' },
  payment: { paid: 'Received', pending: 'Pending', failed: 'Failed', refunded: 'Refunded' },
  level: { info: 'Info', warn: 'Warning', error: 'Error' },
  scope: { auth: 'Account', upload: 'Documents', chat: 'Chat', billing: 'Payments', system: 'System' },
};
export const badge = (value, dict) => `<span class="badge ${esc(value)}">${esc(t(dict?.[value] || value || '—'))}</span>`;

/* ---------- Icons ---------- */
const I = (p, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${p}</svg>`;
export const icon = {
  dashboard: I('<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>'),
  folder: I('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  file: I('<path d="M14 3v5h5"/><path d="M19 8v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7z"/>'),
  users: I('<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><path d="M16.5 5.2a3.2 3.2 0 0 1 0 5.9M18 14.8c2 .7 3.5 2.4 3.5 4.7"/>'),
  chat: I('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5A8 8 0 1 1 21 12z"/>'),
  history: I('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 4v4h4"/><path d="M12 8v4l3 2"/>'),
  building: I('<path d="M4 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16"/><path d="M15 9h3a2 2 0 0 1 2 2v10"/><path d="M8 7h3M8 11h3M8 15h3"/><path d="M2 21h20"/>'),
  card: I('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>'),
  chart: I('<path d="M3 3v18h18"/><path d="M7 15l3.5-4 3 2.5L20 7"/>'),
  shield: I('<path d="M12 3l7.5 3v5.5c0 4.6-3.1 8.4-7.5 9.5-4.4-1.1-7.5-4.9-7.5-9.5V6z"/>'),
  settings: I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.4 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 15a2 2 0 1 1 0-4 1.6 1.6 0 0 0 1.6-1.1l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 4.6V4a2 2 0 1 1 4 0v.1A1.6 1.6 0 0 0 16.6 5.6l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.6 1.6 0 0 0 21 11a2 2 0 1 1 0 4z"/>'),
  logout: I('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>'),
  plus: I('<path d="M12 5v14M5 12h14"/>'),
  search: I('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
  trash: I('<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/><path d="M9 7V4h6v3"/>'),
  download: I('<path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/>'),
  refresh: I('<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>'),
  upload: I('<path d="M12 19V7"/><path d="M7 11l5-5 5 5"/><path d="M4 20h16"/>'),
  edit: I('<path d="M4 20h4l10-10a2.8 2.8 0 1 0-4-4L4 16z"/>'),
  close: I('<path d="M6 6l12 12M18 6L6 18"/>'),
  menu: I('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  check: I('<path d="M5 13l4 4L19 7"/>'),
  alert: I('<path d="M12 8v5M12 17h.01"/><circle cx="12" cy="12" r="9"/>'),
  info: I('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  inbox: I('<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5.5 5h13l2.5 8v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z"/>'),
  send: I('<path d="M21 3L3 10.5l7 3 3 7z"/><path d="M21 3l-11 11"/>'),
  key: I('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9"/><path d="M17 6l2 2M15 8l2 2"/>'),
  pulse: I('<path d="M3 12h4l3-8 4 16 3-8h4"/>'),
  db: I('<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>'),
  lock: I('<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>'),
  globe: I('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.5 3.8 5.6 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.6-3.8-9S9.5 5.5 12 3z"/>'),
  scan: I('<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M3 12h18"/>'),
};

/* ---------- Toasts ---------- */
export function toast(message, type = '') {
  let host = document.querySelector('.toasts');
  if (!host) { host = document.createElement('div'); host.className = 'toasts'; document.body.appendChild(host); }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${type === 'err' ? icon.alert : type === 'ok' ? icon.check : icon.info}<div>${esc(message)}</div>`;
  host.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; setTimeout(() => el.remove(), 260); }, 3600);
}

/* ---------- Dialogs ---------- */
export function modal({ title, body, okText = 'Save', cancelText = 'Cancel', wide = false, danger = false, hideCancel = false, onOk }) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop open';
  back.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}">
      <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-x>${icon.close}</button></div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot">
        ${hideCancel ? '' : `<button class="btn" data-x>${esc(cancelText)}</button>`}
        <button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(okText)}</button>
      </div>
    </div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.querySelectorAll('[data-x]').forEach((b) => (b.onclick = close));
  back.onclick = (e) => { if (e.target === back) close(); };
  const okBtn = back.querySelector('[data-ok]');
  okBtn.onclick = async () => {
    if (!onOk) return close();
    okBtn.disabled = true;
    try { const r = await onOk(back); if (r !== false) close(); }
    catch (err) { toast(err.message, 'err'); }
    finally { okBtn.disabled = false; }
  };
  const first = back.querySelector('input, select, textarea');
  if (first) setTimeout(() => first.focus(), 40);
  return { el: back, close };
}

export function confirmDialog(title, message, okText = 'Delete') {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const m = modal({ title, body: `<p>${esc(message)}</p>`, okText, danger: true, onOk: () => finish(true) });
    m.el.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', () => finish(false)));
    m.el.addEventListener('click', (e) => { if (e.target === m.el) finish(false); });
  });
}

/* ---------- Bar chart ---------- */
export function renderBars(el, series, key = 'questions') {
  const max = Math.max(1, ...series.map((s) => s[key]));
  el.innerHTML = `
    <div class="bars">${series
      .map((s) => `<div class="bar" title="${esc(fmt.date(s.day))}: ${fmt.num(s[key])}"><i style="height:${Math.round((s[key] / max) * 100)}%"></i></div>`)
      .join('')}</div>
    <div class="chart-axis"><span>${esc(fmt.date(series[0]?.day))}</span><span>${esc(fmt.date(series[series.length - 1]?.day))}</span></div>`;
}

/* ---------- Usage meters ---------- */
export function meter(used, limit) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const cls = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '';
  return `<div class="meter ${cls}"><i style="width:${pct}%"></i></div>`;
}

/* ---------- Navigation shell ---------- */
export function buildSidebar({ brandSub, items, user, orgs, currentOrgId, onOrgChange }) {
  const orgBlock = orgs
    ? `<div class="org-switch">
         <label>Organization</label>
         <select id="orgSwitch">${orgs.map((o) => `<option value="${esc(o.id)}" ${o.id === currentOrgId ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select>
       </div>` : '';

  const nav = items
    .map((it) =>
      it.group
        ? `<div class="nav-group">${esc(it.group)}</div>`
        : `<button class="nav-item" data-view="${esc(it.view)}">${icon[it.icon] || ''}<span>${esc(it.label)}</span></button>`
    )
    .join('');

  return `
    <aside class="sidebar" id="appSidebar">
      <div class="brand">
        <img class="brand-mark" src="/assets/brand/mark-light.png" alt="BotClarify" />
        <div><div class="brand-name">BotClarify</div><div class="brand-sub">${esc(brandSub)}</div></div>
        <button class="drawer-close" type="button" aria-label="Close menu">${icon.close}</button>
      </div>
      ${orgBlock}
      <nav class="nav">${nav}</nav>
      <div class="sidebar-foot">
        <div class="user-chip">
          <div class="avatar">${esc(initials(user.full_name || user.email))}</div>
          <div class="who"><b>${esc(user.full_name || user.email.split('@')[0])}</b><span>${esc(user.email)}</span></div>
        </div>
        <button class="nav-item" id="logoutBtn" style="margin-top:6px">${icon.logout}<span>Sign out</span></button>
      </div>
    </aside>`;
}

/* ---------- Hash router ---------- */
export function router(onChange, fallback) {
  const go = () => {
    const view = location.hash.replace('#', '') || fallback;
    document.querySelectorAll('.nav-item[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    document.querySelectorAll('.page-section').forEach((s) => s.classList.toggle('active', s.dataset.view === view));
    onChange(view);
  };
  window.addEventListener('hashchange', go);
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.nav-item[data-view]');
    if (b) location.hash = b.dataset.view;
  });
  go();
}

/**
 * Countdown banner for the free trial.
 * Mounted at the top of <body> on every customer page; renders nothing when
 * the organization is not on a trial.
 */
export function trialBanner(trial, { upgradeHref = '/pricing.html' } = {}) {
  if (!trial?.isTrial) return '';

  if (trial.expired) {
    return `
      <div class="trial-bar danger">
        <span>${icon.alert}</span>
        <span><b>${esc(t('Trial ended'))}</b> — ${esc(trial.purged
          ? t('Your documents were deleted. Upgrade to start again.')
          : t('Upgrade now to keep your documents.'))}</span>
        <a class="btn sm primary" href="${upgradeHref}">${esc(t('Upgrade now'))}</a>
      </div>`;
  }

  const hoursLeft = trial.msLeft / 3600000;
  const urgent = hoursLeft < 24;
  return `
    <div class="trial-bar ${urgent ? 'warn' : ''}">
      <span>${icon.info}</span>
      <span>${esc(t('{time} left in your trial', { time: fmt.duration(trial.msLeft) }))} — ${esc(t('all documents are deleted when it ends'))}</span>
      <a class="btn sm ${urgent ? 'primary' : ''}" href="${upgradeHref}">${esc(t('Upgrade now'))}</a>
    </div>`;
}

export const emptyState = (text, sub = '') =>
  `<div class="empty">${icon.inbox}<b>${esc(text)}</b>${sub ? `<div>${esc(sub)}</div>` : ''}</div>`;

/* ---------- Mobile navigation drawer ---------- */
/**
 * Turn the sidebar into a hamburger drawer on small screens.
 *
 * Call once per page, after the shell has been written into the DOM. The
 * toggle is inserted into the existing .topbar rather than into each page's
 * markup, so the three consoles stay in step with one another.
 *
 * Everything here is behaviour only: the drawer, the scrim and the toggle are
 * all hidden above the breakpoint by CSS alone, so a wide screen is unaffected
 * whether or not this ever runs.
 */
export function mountMobileNav() {
  const sidebar = document.getElementById('appSidebar');
  const topbar = document.querySelector('.topbar');
  const main = document.querySelector('.main');
  if (!sidebar || !topbar || document.querySelector('.nav-toggle')) return;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'nav-toggle';
  toggle.setAttribute('aria-label', 'Menu');
  toggle.setAttribute('aria-controls', 'appSidebar');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.innerHTML = icon.menu;
  topbar.prepend(toggle);

  const scrim = document.createElement('div');
  scrim.className = 'nav-scrim';
  document.body.appendChild(scrim);

  // Matches the breakpoint in app.css. Held as a media query rather than read
  // from window.innerWidth so the two cannot drift apart silently, and so
  // turning a phone sideways is handled without a resize listener.
  const small = window.matchMedia('(max-width: 1000px)');

  /**
   * Everything the open drawer covers, EXCEPT the hamburger.
   *
   * The obvious move is to mark .main inert, and it is wrong: the hamburger
   * lives inside .main's topbar, and inert makes a whole subtree unclickable.
   * The button could open the drawer and then never close it. So the siblings
   * are listed instead — the topbar's other children, the rest of .main, and
   * the trial banner, which sits outside .shell entirely and would otherwise
   * stay reachable by Tab from behind the scrim.
   */
  const covered = () => [
    ...(main ? [...main.children].filter((el) => el !== topbar) : []),
    ...[...topbar.children].filter((el) => el !== toggle),
    document.getElementById('trialBar'),
  ].filter(Boolean);

  function setOpen(open) {
    sidebar.classList.toggle('open', open);
    scrim.classList.toggle('open', open);
    document.body.classList.toggle('nav-open', open);
    toggle.setAttribute('aria-expanded', String(open));

    // The scrim stops the mouse but not the keyboard: without this, Tab walks
    // through a page the person cannot see, and a screen reader reads it out.
    for (const el of covered()) {
      if (open) el.setAttribute('inert', '');
      else el.removeAttribute('inert');
    }

    // A closed drawer is off-canvas, not hidden — transform takes nothing out
    // of the tab order. Left alone, tabbing on a phone walked through the
    // organization switcher, every menu item and Sign out, all off-screen with
    // no visible focus ring.
    syncClosedDrawer(open);

    if (open) sidebar.querySelector('.drawer-close')?.focus({ preventScroll: true });
    else toggle.focus({ preventScroll: true });
  }

  function syncClosedDrawer(open) {
    if (small.matches && !open) sidebar.setAttribute('inert', '');
    else sidebar.removeAttribute('inert');
  }

  const close = () => { if (sidebar.classList.contains('open')) setOpen(false); };

  toggle.addEventListener('click', () => setOpen(!sidebar.classList.contains('open')));
  scrim.addEventListener('click', close);
  sidebar.querySelector('.drawer-close')?.addEventListener('click', close);

  // Choosing a destination closes the drawer: on a phone the page behind it is
  // the thing being navigated to, so leaving the drawer open would make every
  // menu choice need a second, dismissing tap.
  sidebar.addEventListener('click', (e) => { if (e.target.closest('.nav-item')) close(); });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  // Crossing the breakpoint either way. Growing past it puts the sidebar back
  // into the layout, so the body must not stay scroll-locked and the page must
  // not stay inert on a desktop that no longer has a drawer to close; shrinking
  // below it means the now-off-canvas drawer has to leave the tab order.
  small.addEventListener('change', () => { close(); syncClosedDrawer(false); });

  syncClosedDrawer(false);
}
