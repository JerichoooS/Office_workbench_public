// shell.js — 应用外框：桌面侧边栏、手机底部标签栏
// 导航（用户确认 2026-10-20）：
//   手机底部：首页 / 看板 / ＋记一条 / 项目 / 设置（不再有「更多」）
//   首页里：左上角「概览」（=负一屏，也可从左往右滑打开）、右上角「日历」
//   电脑侧边栏：首页 / 看板 / 项目 / 材料收集 …… 设置（电脑没有滑动手势，材料收集直接放侧边栏）

import { esc, icon } from '../core/dom.js';
import { go } from '../core/router.js';
import { userName } from '../core/auth.js';
import { openCapture } from './capture.js';

const SIDE = [['/today', '首页', 'today'], ['/board', '看板', 'board'], ['/tasks', '项目', 'tasks'], ['/collections', '材料收集', 'coll']];
const SETTINGS = ['/settings', '设置', 'set'];

const navBtn = ([path, label, ic]) => `<button class="nav-btn" data-go="${path}">${icon(ic)}${label}</button>`;

export function renderShell(root, session) {
  root.innerHTML = `<div class="app">
    <aside class="side" aria-label="导航">
      <div class="brand"><span class="brand-mark"></span>工作台</div>
      ${SIDE.map(navBtn).join('')}
      <div class="sp"></div>
      ${navBtn(SETTINGS)}
      <div class="hint" style="padding:8px 10px">${esc(userName(session))}</div>
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
    if (e.target.closest('[data-capture]')) openCapture();
  });
}

export function updateNav(path) {
  const top = '/' + (path.split('/')[1] || 'today');
  document.querySelectorAll('.side [data-go], .tabbar [data-go]').forEach(b => {
    if (b.dataset.go === top) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
}
