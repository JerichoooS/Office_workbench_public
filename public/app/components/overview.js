// overview.js — 首页「负一屏」：在首页从左往右滑（或点左上角图标）打开
// 内容（用户确认）：本周概览 / 材料收集 / 零星待办（没归入项目的待办）/ 全部待办与搜索
// 电脑端没有滑动手势：同样由首页左上角图标打开，材料收集另在侧边栏有入口。

import { esc, icon, openLeft, closeLeft } from '../core/dom.js';
import { go } from '../core/router.js';
import { startOfDay, addDays, dayDiff, isOverdue } from '../core/dates.js';
import { listTodos } from '../data/repos/todos.js';
import { listCollections } from '../data/repos/collections.js';
import { todoRow } from './todo-row.js';
import { openTodo } from './todo-detail.js';
import { openMoveSheet } from './move.js';

export async function openOverview() {
  const el = openLeft('<div class="d-head">加载中…</div>', { label: '概览' });
  const [todos, cols] = await Promise.all([listTodos(), listCollections({ includeClosed: false })]);
  const now = new Date(), monday = addDays(startOfDay(now), -((now.getDay() + 6) % 7));
  const open = todos.filter(t => t.status !== 'done');
  // 本周概览：每个数字可点，下方列出对应的待办
  const stats = [
    ['done', '本周完成', todos.filter(t => t.completed_at && new Date(t.completed_at) >= monday), ''],
    ['overdue', '逾期', open.filter(t => isOverdue(t)), 'bad'],
    ['waiting', '等待他人', open.filter(t => t.status === 'waiting'), 'wait'],
    ['week', '本周到期', open.filter(t => t.due_at && dayDiff(new Date(t.due_at)) >= 0 && new Date(t.due_at) < addDays(monday, 7)), ''],
  ];
  const inbox = open.filter(t => !t.task_id);
  el.innerHTML = `<div class="d-head"><b style="color:var(--ink);font-size:14px">概览</b><span class="sp"></span><button class="btn small" data-x>关闭</button></div>
  <div class="d-body">
    <div class="stats">${stats.map(([k, l, rows, c]) => `<button class="stat ${c}" data-stat="${k}" aria-pressed="false"><span class="num">${rows.length}</span><span>${l} ›</span></button>`).join('')}</div>
    <div class="list" id="ov-stat" hidden></div>

    <div class="group"><div class="group-h"><b>材料收集</b><span class="num">${cols.length}</span><span class="sp"></span><button class="hint" data-go="/collections">全部 ›</button></div>
      <div class="list">${cols.map(c => `<button class="item plain" data-go="/collections?c=${c.id}" style="width:100%;text-align:left"><div class="t-title">${esc(c.title)}</div><div class="t-side num">${c.done}/${c.total}</div></button>`).join('') || '<div class="empty">没有进行中的收集</div>'}
        <button class="item plain" data-go="/collections?new=" style="width:100%;text-align:left;color:var(--accent)"><div>＋ 发起材料收集</div><span></span></button></div></div>

    <div class="group"><div class="group-h"><b>${icon('inbox')} 零星待办</b><span class="num">${inbox.length}</span><span>· 没归入项目的待办</span></div>
      <div class="list" id="ov-inbox">${inbox.map(t => todoRow(t, { move: true })).join('') || '<div class="empty">没有零星待办</div>'}</div></div>

    <div class="group"><div class="group-h"><b>全部待办</b><span class="sp"></span><button class="hint" data-go="/all">打开 ›</button></div>
      <form class="search" id="ov-search"><span class="hint">搜索</span><input id="ov-q" placeholder="标题、标签、等待对象、项目名" enterkeyhint="search"></form></div>
  </div>`;
  // 在面板上往左滑 = 关闭（和打开的手势对称）
  if (!el._swipe) {
    el._swipe = true;
    let sx = null, sy = 0;
    el.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    el.addEventListener('touchend', e => { if (sx === null) return; const t = e.changedTouches[0], dx = t.clientX - sx; if (dx < -70 && Math.abs(dx) > Math.abs(t.clientY - sy) * 1.8) closeLeft(); sx = null; }, { passive: true });
  }
  el.querySelector('#ov-search').onsubmit = e => { e.preventDefault(); const q = el.querySelector('#ov-q').value.trim(); closeLeft(); go('/all' + (q ? '?q=' + encodeURIComponent(q) : '')); };
  el.onclick = e => {
    if (e.target.closest('[data-x]')) { closeLeft(); return; }
    const st = e.target.closest('[data-stat]');
    if (st) {
      const box = el.querySelector('#ov-stat'), on = st.getAttribute('aria-pressed') === 'true';
      el.querySelectorAll('[data-stat]').forEach(b => b.setAttribute('aria-pressed', 'false'));
      if (on) { box.hidden = true; return; }
      st.setAttribute('aria-pressed', 'true');
      const rows = stats.find(x => x[0] === st.dataset.stat)[2];
      box.hidden = false; box.classList.remove('reveal'); void box.offsetWidth; box.classList.add('reveal');
      box.innerHTML = rows.map(t => todoRow(t)).join('') || '<div class="empty">没有</div>';
      return;
    }
    const g = e.target.closest('[data-go]');
    if (g) { closeLeft(); go(g.dataset.go); return; }
    const mv = e.target.closest('[data-move]');
    if (mv) { const x = todos.find(y => String(y.id) === mv.dataset.move); openMoveSheet(mv.dataset.move, x && x.title, () => openOverview()); return; }
    const t = e.target.closest('[data-todo]');
    if (t && !e.target.closest('[data-check]')) { closeLeft(); openTodo(t.dataset.todo); }
  };
}

/** 首页上「从左往右滑」打开负一屏（只在手机布局，横向滑动明显大于纵向时触发） */
export function bindOverviewSwipe(root) {
  let x0 = null, y0 = 0;
  root.addEventListener('touchstart', e => { if (e.touches.length !== 1) return; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  root.addEventListener('touchend', e => {
    if (x0 === null) return;
    const t = e.changedTouches[0], dx = t.clientX - x0, dy = Math.abs(t.clientY - y0);
    x0 = null;
    if (!window.matchMedia('(max-width: 760px)').matches) return;
    if (e.target.closest('input, textarea, .capture')) return;
    if (dx > 70 && dx > dy * 1.8) openOverview();
  }, { passive: true });
}
