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
};
export const icon = name => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;

// ---------- toast ----------
export function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('on'), 1900);
}
window.WBToast = toast;

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
