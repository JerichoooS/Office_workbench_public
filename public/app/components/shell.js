// shell.js — 应用外框：桌面侧边栏、手机底部标签栏、全局快捷键
// 导航（用户确认 2026-10-20，2026-10-22 补充电脑侧边栏入口）：
//   手机底部：首页 / 看板 / ＋记一条 / 项目 / 设置（不再有「更多」）
//   首页里：左上角「概览」（=负一屏，也可从左往右滑打开）、右上角「日历」
//   电脑侧边栏：搜索（Ctrl/⌘K）、＋记一条（N）、首页 / 看板 / 项目 / 日历 / 材料收集 / 全部待办 …… 设置、同步状态
//   电脑没有滑动手势，所以负一屏里的入口在侧边栏都有一份。

import { esc, icon } from '../core/dom.js';
import { go } from '../core/router.js';
import { userName } from '../core/auth.js';
import { openCapture } from './capture.js';
import { syncDot } from './sync.js';

const SIDE = [['/today', '首页', 'today'], ['/board', '看板', 'board'], ['/tasks', '项目', 'tasks'], ['/calendar', '日历', 'cal'], ['/collections', '材料收集', 'coll'], ['/all', '全部待办', 'all']];
const SETTINGS = ['/settings', '设置', 'set'];
const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const navBtn = ([path, label, ic]) => `<button class="nav-btn" data-go="${path}">${icon(ic)}${label}</button>`;

export function renderShell(root, session) {
  root.innerHTML = `<div class="app">
    <aside class="side" aria-label="导航">
      <div class="brand"><span class="brand-mark"></span>工作台</div>
      <button class="side-search" data-search>${icon('search')}<span>搜索</span><kbd>${MAC ? '⌘' : 'Ctrl'} K</kbd></button>
      <button class="side-add" data-capture>${icon('plus')}<span>记一条</span><kbd>N</kbd></button>
      <div class="side-gap"></div>
      ${SIDE.map(navBtn).join('')}
      <div class="sp"></div>
      ${navBtn(SETTINGS)}
      <div class="side-foot">${syncDot({ wide: true })}<span class="hint">${esc(userName(session))}</span></div>
    </aside>
    <main class="main" id="main"></main>
    <nav class="tabbar" aria-label="导航">
      <button data-go="/today">${icon('today')}首页</button>
      <button data-go="/board">${icon('board')}看板</button>
      <button class="fab" data-capture aria-label="记一条"><span>+</span></button>
      <button data-go="/tasks">${icon('tasks')}项目</button>
      <button data-go="/settings">${icon('set')}设置</button>
    </nav>
  </div>`;
  root.addEventListener('click', e => {
    const g = e.target.closest('[data-go]');
    if (g && g.closest('.side, .tabbar')) { go(g.dataset.go); return; }
    if (e.target.closest('[data-search]')) { openSearch(); return; }
    if (e.target.closest('[data-capture]')) openCapture();
  });
  document.addEventListener('keydown', onKey);
}

/** 打开搜索：已在全部待办页就直接把光标放进搜索框 */
function openSearch() {
  const inp = document.getElementById('all-q');
  if (inp) { inp.focus(); inp.select(); return; }
  go('/all?focus=1');
}

const typing = el => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
function onKey(e) {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); return; }
  if (e.key.toLowerCase() === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(document.activeElement)
    && !document.querySelector('.sheet.open, .drawer.open')) { e.preventDefault(); openCapture(); }
}

export function updateNav(path) {
  const top = '/' + (path.split('/')[1] || 'today');
  document.querySelectorAll('.side [data-go], .tabbar [data-go]').forEach(b => {
    if (b.dataset.go === top) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
}
