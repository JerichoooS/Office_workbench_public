// all.js — 全部待办（独立页面 #/all）：按项目分组、可搜索、可显示已完成
// 入口：首页底部「查看全部待办」、负一屏「全部待办」与搜索。

import { esc } from '../core/dom.js';
import { listTodos, setStatus } from '../data/repos/todos.js';
import { listTasks } from '../data/repos/tasks.js';
import { contactById } from '../data/repos/contacts.js';
import { todoRow, byId } from '../components/todo-row.js';
import { openTodo } from '../components/todo-detail.js';

let q = '', withDone = false;

/** 渲染到 root（项目页提供的容器）；opts.q 来自 #/tasks?view=all&q=… */
export async function mountAll(root, opts = {}) {
  if (opts.q !== undefined && opts.q !== null) { q = opts.q; opts.q = null; }
  const [todos, tasks, archived] = await Promise.all([listTodos(), listTasks(), listTasks({ archived: true })]);
  const T = byId([...tasks, ...archived]);
  const match = t => {
    if (!withDone && t.status === 'done') return false;
    if (!q) return true;
    const w = contactById(t.waiting_on);
    return [t.title, t.notes, ...(t.tags || []), w && w.name, T[t.task_id] && T[t.task_id].title].some(x => x && x.includes(q));
  };
  const rows = todos.filter(match);
  const groups = [...tasks, ...archived].map(t => ({ title: t.title, rows: rows.filter(x => String(x.task_id) === String(t.id)) }))
    .concat([{ title: '零星待办（未归入项目）', rows: rows.filter(x => !x.task_id || !T[x.task_id]) }]).filter(g => g.rows.length);
  root.innerHTML = `<div style="display:flex;flex-direction:column;gap:18px">
    <div style="display:flex;gap:10px;align-items:center"><span class="hint">按项目分组 · 共 <span class="num">${rows.length}</span> 条</span><span class="sp"></span>
      <button class="chip ${withDone ? 'accent' : 'ghost'}" data-done>显示已完成</button></div>
    <div class="search"><span class="hint">搜索</span><input id="all-q" value="${esc(q)}" placeholder="标题、标签、等待对象、项目名" autocomplete="off"></div>
    ${groups.map(g => `<div class="group"><div class="group-h"><b>${esc(g.title)}</b><span class="num">${g.rows.length}</span></div><div class="list">${g.rows.map(t => todoRow(t, { hideTask: true })).join('')}</div></div>`).join('') || '<div class="placeholder">没有符合条件的待办</div>'}
  </div>`;
  const inp = root.querySelector('#all-q');
  let timer;
  inp.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { q = inp.value.trim(); mountAll(root).then(() => { const i = root.querySelector('#all-q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 250); });
  root.onclick = async e => {
    if (e.target.closest('[data-done]')) { withDone = !withDone; mountAll(root); return; }
    const chk = e.target.closest('[data-check]');
    if (chk) { e.stopPropagation(); const t = todos.find(x => String(x.id) === chk.dataset.check); await setStatus(t, t.status === 'done' ? 'todo' : 'done', { task: T[t.task_id] }); return; }
    const row = e.target.closest('[data-todo]'); if (row) openTodo(row.dataset.todo);
  };
}

export async function mount(root) {
  const q = new URLSearchParams(location.hash.split('?')[1] || '').get('q');
  root.innerHTML = '<div class="wrap wide"><div><a class="btn small" href="#/today">‹ 首页</a></div><div class="page-head"><h1>全部待办</h1></div><div id="all-box"></div></div>';
  await mountAll(root.querySelector('#all-box'), { q });
}
