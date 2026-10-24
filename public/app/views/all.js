// all.js — 全部待办（独立页面 #/all）：按项目分组、可搜索、可显示已完成
// 入口：首页底部「查看全部待办」、负一屏搜索框、电脑侧边栏「全部待办」「搜索」（Ctrl/⌘K）。
// 搜索规则见 data/search.js（不分大小写、忽略空格，含备注、子步骤、进展、项目说明）。
// 输入时只重画结果，搜索框本身不重建（手机键盘不会收起再弹出）。
// 先读「没完成的 + 近期完成的」；开始搜索或点「显示已完成」时才把全部已完成的读进来。

import { esc, icon } from '../core/dom.js';
import { listTodos } from '../data/repos/todos.js';
import { listTasks } from '../data/repos/tasks.js';
import { searchTodos, logsByTodo } from '../data/search.js';
import { todoRow, byId, toggleDone } from '../components/todo-row.js';
import { openTodo } from '../components/todo-detail.js';

let q = '', withDone = false;

/** 渲染到 root；opts.q 来自 #/all?q=…；opts.focus 打开后把光标放进搜索框 */
export async function mountAll(root, opts = {}) {
  if (opts.q !== undefined && opts.q !== null) q = opts.q;
  root.innerHTML = `<div class="all-box">
    <div class="search">${icon('search')}<input id="all-q" type="search" value="${esc(q)}" placeholder="搜索标题、备注、进展、联系人、项目" autocomplete="off" enterkeyhint="search" aria-label="搜索待办"></div>
    <div id="all-res" aria-live="polite"><div class="hint">加载中…</div></div></div>`;
  const inp = root.querySelector('#all-q'), res = root.querySelector('#all-res');
  if (opts.focus) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }

  let [todos, tasks, archived] = await Promise.all([listTodos(), listTasks(), listTasks({ archived: true })]);
  const all = [...tasks, ...archived], T = byId(all);
  let logs = null, full = false;

  const draw = async () => {
    if ((q || withDone) && !full) { todos = await listTodos({ done: 'all' }); full = true; }
    if (q && !logs) logs = await logsByTodo();
    // 搜索时已完成的也一起搜（找过去的记录是搜索最常见的用途），不搜索时按「显示已完成」开关
    const rows = searchTodos(todos.filter(t => q || withDone || t.status !== 'done'), q, { tasks: T, logs: logs || {} });
    const groups = all.map(t => ({ title: t.title + (t.archived_at ? '（已归档）' : ''), rows: rows.filter(x => String(x.task_id) === String(t.id)) }))
      .concat([{ title: '零星待办（未归入项目）', rows: rows.filter(x => !x.task_id || !T[x.task_id]) }]).filter(g => g.rows.length);
    res.innerHTML = `<div class="all-bar"><span class="hint">${q ? `找到 <span class="num">${rows.length}</span> 条（含已完成）` : `按项目分组 · 共 <span class="num">${rows.length}</span> 条`}</span><span class="sp"></span>
        ${q ? '' : `<button class="chip ${withDone ? 'accent' : 'ghost'}" data-done aria-pressed="${withDone}">显示已完成</button>`}</div>
      ${groups.map(g => `<div class="group"><div class="group-h"><b>${esc(g.title)}</b><span class="num">${g.rows.length}</span></div><div class="list">${g.rows.map(t => todoRow(t, { hideTask: true })).join('')}</div></div>`).join('')
        || `<div class="placeholder">${q ? `没有找到「${esc(q)}」。试试少打几个字，或换个说法。` : '没有待办'}</div>`}`;
  };

  let timer;
  inp.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { q = inp.value.trim(); draw(); }, 200); });
  root.onclick = async e => {
    if (e.target.closest('[data-done]')) { withDone = !withDone; draw(); return; }
    const chk = e.target.closest('[data-check]');
    if (chk) { e.stopPropagation(); const t = todos.find(x => String(x.id) === chk.dataset.check); await toggleDone(t, { task: T[t.task_id], el: chk }); return; }
    const row = e.target.closest('[data-todo]'); if (row) openTodo(row.dataset.todo);
  };
  await draw();
}

export async function mount(root) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  // 地址里的 q / focus 只用一次（之后数据刷新重绘时不再抢光标、不覆盖新输入的搜索词）
  if (params.has('q') || params.has('focus')) history.replaceState(null, '', '#/all');
  root.innerHTML = '<div class="wrap wide"><div><a class="btn small" href="#/today">‹ 首页</a></div><div class="page-head"><h1>全部待办</h1></div><div id="all-box"></div></div>';
  await mountAll(root.querySelector('#all-box'), { q: params.get('q'), focus: params.has('focus') });
}
