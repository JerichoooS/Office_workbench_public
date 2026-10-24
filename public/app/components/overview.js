// overview.js — 首页「负一屏」：在首页从左往右滑（或点左上角图标）打开
// 内容（用户确认）：搜索（最上面）/ 本周概览（四个数字一行，可点开列表）+ 写周报 / 材料收集 / 零星待办（没归入项目的待办）
// 电脑端没有滑动手势：同样由首页左上角图标打开，材料收集另在侧边栏有入口。

import { esc, icon, openLeft, closeLeft } from '../core/dom.js';
import { go } from '../core/router.js';
import { startOfDay, addDays, dayDiff, isOverdue } from '../core/dates.js';
import { listTodos } from '../data/repos/todos.js';
import { listCollections } from '../data/repos/collections.js';
import { todoRow, toggleDone } from './todo-row.js';
import { openTodo } from './todo-detail.js';
import { openMoveSheet } from './move.js';
import { openReport } from './report-sheet.js';

export async function openOverview() {
  const el = openLeft('<div class="d-head">加载中…</div>', { label: '概览' });
  let todos, cols;
  try { [todos, cols] = await Promise.all([listTodos(), listCollections({ includeClosed: false })]); }
  catch (e) {
    el.innerHTML = `<div class="d-head"><b class="d-title">概览</b><span class="sp"></span><button class="btn small" data-x>关闭</button></div><div class="d-body"><div class="placeholder">${esc(e.message || '没能加载')}<button class="btn small" data-retry>重试</button></div></div>`;
    el.onclick = ev => { if (ev.target.closest('[data-x]')) closeLeft(); if (ev.target.closest('[data-retry]')) openOverview(); };
    return;
  }
  const now = new Date(), monday = addDays(startOfDay(now), -((now.getDay() + 6) % 7));
  const open = todos.filter(t => t.status !== 'done');
  // 本周概览：每个数字可点，下方列出对应的待办
  const stats = [
    ['done', '本周完成', todos.filter(t => t.status === 'done' && t.completed_at && new Date(t.completed_at) >= monday), 'ok'],
    ['overdue', '逾期', open.filter(t => isOverdue(t)), 'bad'],
    ['waiting', '等待他人', open.filter(t => t.status === 'waiting'), 'wait'],
    ['week', '本周到期', open.filter(t => t.due_at && dayDiff(new Date(t.due_at)) >= 0 && new Date(t.due_at) < addDays(monday, 7)), ''],
  ];
  const inbox = open.filter(t => !t.task_id);
  el.innerHTML = `<div class="d-head"><b class="d-title">概览</b><span class="sp"></span><button class="btn small" data-x>关闭</button></div>
  <div class="d-body">
    <form class="search" id="ov-search" role="search">${icon('search')}<input id="ov-q" type="search" placeholder="搜索全部待办、备注、进展" enterkeyhint="search" aria-label="搜索全部待办"></form>
    <div class="group"><div class="group-h"><b>本周</b><span class="sp"></span><button class="btn small" data-report>${icon('report')}写周报</button></div>
      <div class="stats four">${stats.map(([k, l, rows, c]) => `<button class="stat ${c}" data-stat="${k}" aria-pressed="false"><span class="num">${rows.length}</span><span>${l}</span></button>`).join('')}</div>
      <div class="list" id="ov-stat" hidden></div></div>

    <div class="group"><div class="group-h"><b>材料收集</b><span class="num">${cols.length}</span><span class="sp"></span><button class="hint" data-go="/collections">全部 ›</button></div>
      <div class="list">${cols.map(c => `<button class="item plain" data-go="/collections?c=${c.id}" style="width:100%;text-align:left"><div class="t-title">${esc(c.title)}</div><div class="t-side num">${c.done}/${c.total}</div></button>`).join('') || '<div class="empty">没有进行中的收集</div>'}
        <button class="item plain" data-go="/collections?new=" style="width:100%;text-align:left;color:var(--accent)"><div>＋ 发起材料收集</div><span></span></button></div></div>

    <div class="group"><div class="group-h"><b>${icon('inbox')} 零星待办</b><span class="num">${inbox.length}</span><span>· 没归入项目的待办</span></div>
      <div class="list" id="ov-inbox">${inbox.map(t => todoRow(t, { move: true })).join('') || '<div class="empty">没有零星待办</div>'}</div></div>

    <a class="all-link" href="#/all" data-go="/all">查看全部待办 ›</a>
  </div>`;
  // 在面板上往左滑 = 关闭（和打开的手势对称）
  if (!el._swipe) {
    el._swipe = true;
    let sx = null, sy = 0;
    el.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    el.addEventListener('touchend', e => { if (sx === null) return; const t = e.changedTouches[0], dx = t.clientX - sx; if (dx < -70 && Math.abs(dx) > Math.abs(t.clientY - sy) * 1.8) closeLeft(); sx = null; }, { passive: true });
  }
  el.querySelector('#ov-search').onsubmit = e => { e.preventDefault(); const q = el.querySelector('#ov-q').value.trim(); closeLeft(); go('/all' + (q ? '?q=' + encodeURIComponent(q) : '')); };
  el.onclick = async e => {
    if (e.target.closest('[data-x]')) { closeLeft(); return; }
    if (e.target.closest('[data-report]')) { openReport(); return; }
    const chk = e.target.closest('[data-check]');
    if (chk) { e.stopPropagation(); const x = todos.find(y => String(y.id) === chk.dataset.check); await toggleDone(x, { el: chk }); openOverview(); return; }
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
    if (g) { e.preventDefault(); closeLeft(); go(g.dataset.go); return; }
    const mv = e.target.closest('[data-move]');
    if (mv) { const x = todos.find(y => String(y.id) === mv.dataset.move); openMoveSheet(mv.dataset.move, x && x.title, () => openOverview()); return; }
    const t = e.target.closest('[data-todo]');
    if (t) { closeLeft(); openTodo(t.dataset.todo); }
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
