// calendar.js — 月视图：每天的到期待办与催办；格子下方列出选中那天的事项
// 电脑：格子里直接显示事项名（点事项看详情，点空白处选中那天）
// 手机：格子太窄，事项变成小圆点；点某天，下方列出当天事项，可「在这天新建」
// 进行中的项目在月历下方各占一行：起止日期 + 时间进度（替代原来格子底部意义不明的细条）
// 法定节假日、调休上班日在日期旁标「休」「班」（只标 core/holidays.js 里有数据的年份）
// 只读没完成的 + 截止在这几周里的已完成（不再读全部已完成的）

import { esc, toast, openSheet, closeSheet } from '../core/dom.js';
import { ymd, parseYmd, startOfDay, addDays, WD } from '../core/dates.js';
import { listTodos, createTodo } from '../data/repos/todos.js';
import { listTasks, timeInfo } from '../data/repos/tasks.js';
import { holidayMark } from '../core/holidays.js';
import { table, run } from '../data/db.js';
import { openTodo } from '../components/todo-detail.js';
import { todoRow, byId, toggleDone } from '../components/todo-row.js';

let month = null;   // 当前显示月份的 1 号
let sel = null;     // 选中的日期 YYYY-MM-DD

export async function mount(root, _params = {}, ctx = {}) {
  if (!month) { month = startOfDay(new Date()); month.setDate(1); }
  const first = new Date(month), pad = (first.getDay() + 6) % 7;   // 周一开头
  const gridStart = addDays(first, -pad), gridEnd = addDays(gridStart, 42);
  const todayKey = ymd(new Date());
  if (!sel || parseYmd(sel).getMonth() !== first.getMonth() || parseYmd(sel).getFullYear() !== first.getFullYear())
    sel = todayKey.slice(0, 7) === ymd(first).slice(0, 7) ? todayKey : ymd(first);
  const [todos, tasks, nudges] = await Promise.all([
    listTodos({ done: { dueFrom: gridStart, dueTo: gridEnd } }), listTasks(),
    run(table('reminders').select('todo_id,fire_at').eq('kind', 'nudge').is('sent_at', null).gte('fire_at', gridStart.toISOString()).lt('fire_at', gridEnd.toISOString())),
  ]);
  const T = byId(tasks);
  const byDay = {};   // 日期 → [{ kind: 'due'|'nudge', todo }]
  const push = (d, it) => { (byDay[d] = byDay[d] || []).push(it); };
  todos.filter(t => t.due_at).forEach(t => push(ymd(new Date(t.due_at)), { kind: 'due', todo: t }));
  nudges.forEach(n => { const t = todos.find(x => String(x.id) === String(n.todo_id)); if (t) push(ymd(new Date(n.fire_at)), { kind: 'nudge', todo: t }); });

  const ev = ({ kind, todo: t }) => kind === 'nudge'
    ? `<button class="ev w" data-todo="${t.id}" title="催办：${esc(t.title)}">催：${esc(t.title)}</button>`
    : `<button class="ev ${t.status === 'done' ? 'done' : ''}" data-todo="${t.id}" title="${esc(t.title)}">${esc(t.title)}</button>`;
  const dot = ({ kind, todo: t }) => `<i class="${kind === 'nudge' ? 'w' : t.status === 'done' ? 'done' : ''}"></i>`;
  const rows = Math.ceil((pad + new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()) / 7);
  const cells = [];
  for (let i = 0; i < rows * 7; i++) {
    const d = addDays(gridStart, i), k = ymd(d), inM = d.getMonth() === first.getMonth(), items = byDay[k] || [];
    const hol = holidayMark(d.getFullYear(), d.getMonth() + 1, d.getDate());
    cells.push(`<div class="day ${inM ? '' : 'out'} ${k === todayKey ? 'today' : ''} ${k === sel ? 'sel' : ''}" data-day="${k}" role="button" tabindex="0" aria-label="${d.getMonth() + 1}月${d.getDate()}日${hol ? (hol === 'off' ? '，法定节假日' : '，调休上班') : ''}，${items.length} 项">
      <span class="d num">${d.getDate()}</span>${hol ? `<span class="hol ${hol}" aria-hidden="true">${hol === 'off' ? '休' : '班'}</span>` : ''}
      ${items.slice(0, 3).map(ev).join('')}${items.length > 3 ? `<span class="more">+${items.length - 3}</span>` : ''}
      ${items.length ? `<span class="dots">${items.slice(0, 4).map(dot).join('')}</span>` : ''}</div>`);
  }

  const selDate = parseYmd(sel), selItems = byDay[sel] || [];
  const dues = selItems.filter(x => x.kind === 'due').map(x => x.todo), nudgeList = selItems.filter(x => x.kind === 'nudge').map(x => x.todo);
  const active = tasks.filter(t => t.start_date && t.end_date && t.end_date >= ymd(gridStart) && t.start_date < ymd(gridEnd));

  root.innerHTML = `<div class="wrap wide cal-page">
    <div class="page-head"><div><h1><span class="num">${first.getFullYear()}</span> 年 <span class="num">${first.getMonth() + 1}</span> 月</h1><div class="sub">紫色 = 自动催办；点某天看当天事项</div></div><span class="sp"></span>
      <div class="seg"><button data-m="-1" aria-label="上个月">‹</button><button data-m="0">本月</button><button data-m="1" aria-label="下个月">›</button></div></div>
    <div class="cal">${['一', '二', '三', '四', '五', '六', '日'].map(x => `<div class="dow">${x}</div>`).join('')}${cells.join('')}</div>
    <div class="group"><div class="group-h"><b>${selDate.getMonth() + 1}月${selDate.getDate()}日 周${WD[selDate.getDay()]}</b><span class="num">${dues.length}</span><span class="sp"></span><button class="btn small" data-new>＋ 在这天新建</button></div>
      <div class="list">${dues.map(t => todoRow(t, { tasks: T })).join('') || '<div class="empty">这天没有到期的待办</div>'}</div>
      ${nudgeList.length ? `<div class="list">${nudgeList.map(t => `<div class="item plain" data-todo="${t.id}"><div style="min-width:0"><div class="t-title clamp">催：${esc(t.title)}</div></div><span class="t-side"><span class="chip wait">自动催办</span></span></div>`).join('')}</div>` : ''}</div>
    ${active.length ? `<div class="group"><div class="group-h"><b>进行中的项目</b></div><div class="list">${active.map(t => {
      const { ratio, left } = timeInfo(t);
      return `<a class="item plain proj-line" href="#/tasks/${t.id}"><div style="min-width:0"><div class="t-title clamp">${esc(t.title)}</div>
        <div class="prog"><i style="width:${(ratio || 0) * 100}%"></i></div></div>
        <span class="t-side num">${esc(t.start_date.slice(5))} → ${esc(t.end_date.slice(5))}<br>${left >= 0 ? `剩 ${left} 天` : '已结束'}</span></a>`;
    }).join('')}</div></div>` : ''}
  </div>`;

  const pick = k => { sel = k; mount(root, _params, ctx); };
  root.onclick = async e => {
    const m = e.target.closest('[data-m]');
    if (m) { const v = +m.dataset.m; if (v === 0) { month = startOfDay(new Date()); month.setDate(1); sel = null; } else month.setMonth(month.getMonth() + v); mount(root, _params, ctx); return; }
    const chk = e.target.closest('[data-check]');
    if (chk) { e.stopPropagation(); const t = todos.find(x => String(x.id) === chk.dataset.check); await toggleDone(t, { task: T[t.task_id], el: chk }); return; }
    if (e.target.closest('[data-new]')) { newOnDay(sel); return; }
    const t = e.target.closest('.ev, .item[data-todo]');
    // 手机上格子里的事项是隐藏的，点格子 = 选中那天
    if (t && t.offsetParent !== null) { if (ctx.inSheet) closeSheet(); openTodo(t.dataset.todo); return; }
    const day = e.target.closest('[data-day]'); if (day) pick(day.dataset.day);
  };
  root.onkeydown = e => { const day = e.target.closest('[data-day]'); if (day && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pick(day.dataset.day); } };
}

/** 在某天新建一条全天待办（全天待办统一存当天 23:59，与 parse.js、待办详情一致） */
function newOnDay(k) {
  const d = parseYmd(k);
  const el = openSheet(`<div class="sheet-head"><b>${d.getMonth() + 1}月${d.getDate()}日 周${WD[d.getDay()]} 新建待办</b><span class="sp"></span><button class="btn small" data-x="cancel">取消</button><button class="btn small primary" data-x="save">保存</button></div>
    <div class="form"><input id="nd-title" placeholder="要做什么" enterkeyhint="done" aria-label="待办标题"></div>`, { label: '在这天新建' });
  const inp = el.querySelector('#nd-title');
  setTimeout(() => inp.focus(), 250);
  let saving = false;
  const save = async () => {
    const title = inp.value.trim();
    if (!title) { toast('先写下要做什么'); return; }
    if (saving) return; saving = true;
    try { await createTodo({ title, due_at: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59), due_all_day: true }); closeSheet(); toast('已添加到 ' + `${d.getMonth() + 1}月${d.getDate()}日`); }
    catch (_) { saving = false; }
  };
  inp.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) save(); };
  el.onclick = e => { const b = e.target.closest('[data-x]'); if (!b) return; if (b.dataset.x === 'cancel') closeSheet(); else save(); };
}
