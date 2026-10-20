// tasks.js — 项目页：进行中的项目卡片（时间进度 + 待办完成度）+ 零星待办（没归入项目的待办）+ 已归档（可恢复）
// 全部待办是独立页面 #/all（views/all.js），不在这里
// 说明：界面叫「项目」，数据库表和代码里仍叫 tasks（见 docs/开发规范.md §7 命名）

import { esc, toast } from '../core/dom.js';
import { go } from '../core/router.js';
import { listTasks, restoreTask, taskContactIds, timeInfo } from '../data/repos/tasks.js';
import { listTodos } from '../data/repos/todos.js';
import { contactById } from '../data/repos/contacts.js';
import { openTaskForm } from '../components/task-form.js';
import { todoRow } from '../components/todo-row.js';
import { openTodo } from '../components/todo-detail.js';
import { setStatus } from '../data/repos/todos.js';
import { openMoveSheet } from '../components/move.js';

const qs = () => new URLSearchParams(location.hash.split('?')[1] || '');

export async function mount(root) {
  if (qs().get('view') === 'all') { location.replace('#/all'); return; }   // 旧地址兼容
  const head = `<div class="page-head"><div><h1>项目</h1><div class="sub">需要系统性追踪、全流程管理的工作；下面挂多条待办</div></div><span class="sp"></span>
      <button class="btn primary" data-new>＋ 新建项目</button></div>`;
  const [active, archived, todos] = await Promise.all([listTasks(), listTasks({ archived: true }), listTodos()]);
  const cids = Object.fromEntries(await Promise.all(active.map(async t => [t.id, await taskContactIds(t.id)])));

  const card = t => {
    const ts = todos.filter(x => String(x.task_id) === String(t.id)), done = ts.filter(x => x.status === 'done').length;
    const { ratio, left } = timeInfo(t);
    const names = (cids[t.id] || []).map(contactById).filter(Boolean).slice(0, 3);
    return `<div class="task-card" data-task="${t.id}" role="link" tabindex="0">
      <button class="btn small edit" data-edit="${t.id}">✎ 编辑</button>
      <h3>${esc(t.title)}</h3>
      ${ratio !== null ? `<div><div class="span"><span class="num">${esc(t.start_date.slice(5))}</span><span>${left >= 0 ? `剩 <span class="num">${left}</span> 天` : '已结束'}</span><span class="num">${esc(t.end_date.slice(5))}</span></div>
        <div class="prog" title="条 = 待办完成度；竖线 = 今天"><i style="width:${ts.length ? (done / ts.length) * 100 : 0}%"></i><span class="today" style="left:${ratio * 100}%"></span></div></div>` : '<div class="hint">未设起止时间</div>'}
      <div class="task-foot"><span>待办 <span class="num">${done}/${ts.length}</span></span><span class="sp"></span>${names.map(c => `<span class="chip">${esc(c.name)}</span>`).join('')}</div></div>`;
  };

  const inbox = todos.filter(t => !t.task_id && t.status !== 'done');
  root.innerHTML = `<div class="wrap wide">${head}
    ${active.length ? `<div class="tasks">${active.map(card).join('')}</div>` : '<div class="placeholder">还没有进行中的项目。<button class="btn small primary" data-new>新建项目</button></div>'}
    <div class="group"><div class="group-h"><b>零星待办</b><span class="num">${inbox.length}</span><span>· 没归入项目的待办，打开详情可以挪进项目</span></div>
      <div class="list">${inbox.map(t => todoRow(t, { move: true })).join('') || '<div class="empty">没有零星待办</div>'}</div></div>
    ${archived.length ? `<div class="group"><div class="group-h"><b>已归档</b><span class="num">${archived.length}</span><span>· 结束后自动归档，可以恢复</span></div>
      <div class="list">${archived.map(t => `<div class="item plain" data-task="${t.id}"><div style="min-width:0"><div class="t-title">${esc(t.title)}</div><div class="t-meta"><span class="num">${esc(t.start_date || '')} → ${esc(t.end_date || '')}</span></div></div><button class="btn small" data-restore="${t.id}">恢复</button></div>`).join('')}</div></div>` : ''}
  </div>`;

  root.onclick = async e => {
    const mv = e.target.closest('[data-move]');
    if (mv) { e.stopPropagation(); const x = todos.find(y => String(y.id) === mv.dataset.move); openMoveSheet(mv.dataset.move, x && x.title); return; }
    const chk = e.target.closest('[data-check]');
    if (chk) { e.stopPropagation(); const x = todos.find(y => String(y.id) === chk.dataset.check); await setStatus(x, x.status === 'done' ? 'todo' : 'done'); return; }
    const row = e.target.closest('[data-todo]'); if (row) { openTodo(row.dataset.todo); return; }
    const b = e.target.closest('[data-new],[data-edit],[data-restore],[data-task]'); if (!b) return;
    if (b.dataset.new !== undefined) return openTaskForm();
    if (b.dataset.edit) { e.stopPropagation(); return openTaskForm(active.find(t => String(t.id) === b.dataset.edit)); }
    if (b.dataset.restore) { e.stopPropagation(); await restoreTask(b.dataset.restore); toast('已恢复为进行中'); return; }
    if (b.dataset.task) go('/tasks/' + b.dataset.task);
  };
  root.onkeydown = e => { const c = e.target.closest('[data-task]'); if (c && e.key === 'Enter') go('/tasks/' + c.dataset.task); };
}
