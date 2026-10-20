// calendar.js — 月视图：每天显示到期待办与催办；底部细条 = 进行中项目的时间跨度

import { esc } from '../core/dom.js';
import { ymd, parseYmd, startOfDay, addDays } from '../core/dates.js';
import { listTodos } from '../data/repos/todos.js';
import { listTasks } from '../data/repos/tasks.js';
import { table, run } from '../data/db.js';
import { openTodo } from '../components/todo-detail.js';
import { closeSheet } from '../core/dom.js';

let month = null;   // 当前显示月份的 1 号

export async function mount(root, _params = {}, ctx = {}) {
  if (!month) { month = startOfDay(new Date()); month.setDate(1); }
  const first = new Date(month), pad = (first.getDay() + 6) % 7;   // 周一开头
  const gridStart = addDays(first, -pad), gridEnd = addDays(gridStart, 42);
  const [todos, tasks, nudges] = await Promise.all([
    listTodos(), listTasks(),
    run(table('reminders').select('todo_id,fire_at').eq('kind', 'nudge').is('sent_at', null).gte('fire_at', gridStart.toISOString()).lt('fire_at', gridEnd.toISOString())),
  ]);
  const byDay = {};
  const push = (d, html) => { (byDay[d] = byDay[d] || []).push(html); };
  todos.filter(t => t.due_at).forEach(t => push(ymd(new Date(t.due_at)), `<button class="ev ${t.status === 'done' ? 'done' : ''}" data-todo="${t.id}" title="${esc(t.title)}">${esc(t.title)}</button>`));
  nudges.forEach(n => { const t = todos.find(x => String(x.id) === String(n.todo_id)); if (t) push(ymd(new Date(n.fire_at)), `<button class="ev w" data-todo="${t.id}" title="催办：${esc(t.title)}">催：${esc(t.title)}</button>`); });
  const todayKey = ymd(new Date());
  const rows = Math.ceil((pad + new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()) / 7);
  const cells = [];
  for (let i = 0; i < rows * 7; i++) {
    const d = addDays(gridStart, i), k = ymd(d), inM = d.getMonth() === first.getMonth();
    const span = tasks.some(t => t.start_date && t.end_date && k >= t.start_date && k <= t.end_date);
    cells.push(`<div class="day ${inM ? '' : 'out'} ${k === todayKey ? 'today' : ''}"><span class="d num">${d.getDate()}</span>${(byDay[k] || []).slice(0, 3).join('')}${(byDay[k] || []).length > 3 ? `<span class="hint">+${byDay[k].length - 3}</span>` : ''}${span ? '<span class="band"></span>' : ''}</div>`);
  }
  root.innerHTML = `<div class="wrap wide">
    <div class="page-head"><div><h1><span class="num">${first.getFullYear()}</span> 年 <span class="num">${first.getMonth() + 1}</span> 月</h1><div class="sub">紫色 = 自动催办；底部细条 = 有进行中的项目；点事项看详情</div></div><span class="sp"></span>
      <div class="seg"><button data-m="-1" aria-label="上个月">‹</button><button data-m="0">本月</button><button data-m="1" aria-label="下个月">›</button></div></div>
    <div class="cal">${['一', '二', '三', '四', '五', '六', '日'].map(x => `<div class="dow">${x}</div>`).join('')}${cells.join('')}</div></div>`;
  root.onclick = e => {
    const m = e.target.closest('[data-m]');
    if (m) { const v = +m.dataset.m; if (v === 0) { month = startOfDay(new Date()); month.setDate(1); } else month.setMonth(month.getMonth() + v); mount(root, _params, ctx); return; }
    const t = e.target.closest('[data-todo]'); if (t) { if (ctx.inSheet) closeSheet(); openTodo(t.dataset.todo); }
  };
}
