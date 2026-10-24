// dom.js — 视图层通用工具：转义、模板、图标、toast、底部弹层、详情抽屉
// 约定：所有用户输入在拼进 HTML 前必须经过 esc()。

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const ICON_PATHS = {
  today: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/><circle cx="12" cy="14.5" r="1.6"/>',
  board: '<rect x="3.5" y="4" width="5" height="16" rx="1.5"/><rect x="9.5" y="4" width="5" height="11" rx="1.5"/><rect x="15.5" y="4" width="5" height="7" rx="1.5"/>',
  tasks: '<path d="M4 7h16M4 12h16M4 17h10"/><circle cx="18" cy="17" r="2"/>',
  cal: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M8 3v4M16 3v4M7.5 13h2M11 13h2M14.5 13h2M7.5 16.5h2M11 16.5h2"/>',
  coll: '<path d="M5 4h10l4 4v12H5z"/><path d="M15 4v4h4M8.5 13l2 2 4-4"/>',
  all: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  set: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>',
  overview: '<rect x="3.5" y="4" width="7" height="7" rx="1.5"/><rect x="13.5" y="4" width="7" height="7" rx="1.5"/><rect x="3.5" y="13" width="7" height="7" rx="1.5"/><rect x="13.5" y="13" width="7" height="7" rx="1.5"/>',
  inbox: '<path d="M4 13l2.5-8h11L20 13v6H4z"/><path d="M4 13h4.5l1.5 2.5h4l1.5-2.5H20"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  phone: '<path d="M6.5 3.5h3l1.5 4-2 1.3a10 10 0 0 0 6.2 6.2l1.3-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2z"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  report: '<path d="M6 3.5h9l3.5 3.5v13.5H6z"/><path d="M9 11h7M9 14.5h7M9 18h4"/>',
  // 记一条识别结果里的小图标（替代彩色 emoji，深浅色都跟着文字颜色走）
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
  repeat: '<path d="M17 3.5l3 3-3 3"/><path d="M4 11.5v-1a4 4 0 0 1 4-4h12"/><path d="M7 20.5l-3-3 3-3"/><path d="M20 12.5v1a4 4 0 0 1-4 4H4"/>',
  note: '<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4M9 12h6M9 15.5h4"/>',
};
export const icon = name => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;

// ---------- toast ----------
/**
 * 底部提示。opts.action = { label: '撤销', onClick }：带一个按钮（撤销 / 打开 / 重试），停留时间加长；
 * 文字长时自动换行，不会超出屏幕。
 */
export function toast(msg, { action = null, ms } = {}) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.innerHTML = `<span class="toast-msg">${esc(msg)}</span>${action ? `<button type="button" class="toast-act">${esc(action.label)}</button>` : ''}`;
  t.classList.toggle('has-act', !!action);
  if (action) t.querySelector('.toast-act').onclick = () => { t.classList.remove('on'); action.onClick(); };
  t.classList.remove('on'); void t.offsetWidth; t.classList.add('on');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('on'), ms || (action ? 5000 : 2200));
}
window.WBToast = toast;

/**
 * 备注、进展里的文字：转义后把网址变成可点链接、手机号变成可拨号码（在外面直接点着打）。
 * 只认 http(s) 网址和 1 开头的 11 位手机号 / 带区号的座机，其它保持纯文本。
 */
export function linkify(text) {
  return esc(text).replace(/(https?:\/\/[^\s<>"'，。；）)]+)|((?<![\d-])(?:1[3-9]\d{9}|0\d{2,3}-?\d{7,8})(?![\d-]))/g, (m, url, tel) =>
    url ? `<a href="${url}" target="_blank" rel="noopener">${url}</a>` : `<a href="tel:${tel.replace(/-/g, '')}">${tel}</a>`);
}

// ---------- 遮罩、底部弹层、详情抽屉 ----------
function ensure(id, cls, tag = 'div') {
  let el = document.getElementById(id);
  if (!el) { el = document.createElement(tag); el.id = id; el.className = cls; document.body.appendChild(el); }
  return el;
}
const layers = { sheet: null, drawer: null, left: null };
function syncScrim() {
  const s = ensure('scrim', 'scrim');
  s.classList.toggle('on', !!(layers.sheet || layers.drawer || layers.left));
  document.body.classList.toggle('panel-open', !!(layers.drawer || layers.left));   // 详情/负一屏打开时，手机底部栏收起
  s.onclick = () => { if (layers.sheet) closeSheet(); else if (layers.drawer) closeDrawer(); else closeLeft(); };
}

/** 打开底部弹层。html 为内容；onClose 关闭时回调 */
export function openSheet(html, { label = '', onClose } = {}) {
  const el = ensure('sheet', 'sheet', 'section');
  el.setAttribute('aria-label', label);
  el.innerHTML = html;
  layers.sheet = { onClose };
  void el.offsetWidth; el.classList.add('open');   // 强制回流后加类，过渡动画照常；不依赖 rAF（后台页面不触发）
  syncScrim();
  return el;
}
export function closeSheet() {
  const el = document.getElementById('sheet');
  if (el) el.classList.remove('open');
  const cb = layers.sheet && layers.sheet.onClose;
  layers.sheet = null;
  syncScrim();
  if (cb) cb();
}

export function openDrawer(html, { label = '', onClose } = {}) {
  const el = ensure('drawer', 'drawer', 'section');
  el.setAttribute('aria-label', label);
  el.innerHTML = html;
  layers.drawer = { onClose };
  void el.offsetWidth; el.classList.add('open');   // 强制回流后加类，过渡动画照常；不依赖 rAF（后台页面不触发）
  syncScrim();
  return el;
}
export function closeDrawer() {
  const el = document.getElementById('drawer');
  if (el) el.classList.remove('open');
  const cb = layers.drawer && layers.drawer.onClose;
  layers.drawer = null;
  syncScrim();
  if (cb) cb();
}
export const drawerOpen = () => !!(layers.drawer || layers.left);

/** 左侧滑出面板（首页「负一屏」） */
export function openLeft(html, { label = '', onClose } = {}) {
  const el = ensure('leftpanel', 'drawer left', 'section');
  el.setAttribute('aria-label', label);
  el.innerHTML = html;
  layers.left = { onClose };
  void el.offsetWidth; el.classList.add('open');
  syncScrim();
  return el;
}
export function closeLeft() {
  const el = document.getElementById('leftpanel');
  if (el) el.classList.remove('open');
  const cb = layers.left && layers.left.onClose;
  layers.left = null;
  syncScrim();
  if (cb) cb();
}
export const leftOpen = () => !!layers.left;

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (layers.sheet) closeSheet(); else if (layers.drawer) closeDrawer(); else if (layers.left) closeLeft();
});

/** 页面内确认（不使用浏览器 confirm，PWA/各端表现一致） */
export function confirmSheet(text, okLabel = '确定', danger = false) {
  return new Promise(resolve => {
    let done = false;
    const el = openSheet(`<div class="sheet-head"><b>${esc(text)}</b></div>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" data-x="no">取消</button><button class="btn ${danger ? 'danger' : 'primary'}" data-x="ok">${esc(okLabel)}</button></div>`,
      { label: text, onClose: () => { if (!done) resolve(false); } });
    el.onclick = e => {
      const b = e.target.closest('[data-x]'); if (!b) return;
      done = true; resolve(b.dataset.x === 'ok'); closeSheet();
    };
  });
}

/** 复制文字；剪贴板接口不可用（非 https、旧浏览器）时退回选中复制 */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (_) { /* 退回旧方法 */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
  let ok = false; try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
  ta.remove();
  return ok;
}
