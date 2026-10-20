// task-detail.js — 项目详情：进度、说明、联系人、待办（可在本项目下快速新增）、材料收集入口

import { esc, toast, confirmSheet } from '../core/dom.js';
import { go } from '../core/router.js';
import { getTask, taskContactIds, timeInfo, archiveTask, restoreTask, removeTask } from '../data/repos/tasks.js';
import { listTodos, setStatus } from '../data/repos/todos.js';
import { contactById } from '../data/repos/contacts.js';
import { contactKind, taskStatus } from '../data/schema.js';
import { listCollections } from '../data/repos/collections.js';
import { todoRow } from '../components/todo-row.js';
import { mountCapture } from '../components/capture.js';
import { openTodo } from '../components/todo-detail.js';
import { openTaskForm } from '../components/task-form.js';

let showDone = false;

export async function mount(root, { id }) {
  const t = await getTask(id);
  if (!t) { root.innerHTML = '<div class="wrap"><div class="placeholder">项目不存在或已删除。<a href="#/tasks">返回项目</a></div></div>'; return; }
  const [todos, cids, cols] = await Promise.all([listTodos({ taskId: t.id }), taskContactIds(t.id), listCollections({ taskId: t.id })]);
  const open = todos.filter(x => x.status !== 'done'), done = todos.filter(x => x.status === 'done');
  const { ratio, left } = timeInfo(t);
  const contacts = cids.map(contactById).filter(Boolean);

  root.innerHTML = `<div class="wrap wide">
    <div><a class="btn small" href="#/tasks">← 项目</a></div>
    <div class="page-head"><div style="min-width:0"><h1>${esc(t.title)}</h1>
      <div class="sub">${t.start_date ? `<span class="num">${esc(t.start_date)} → ${esc(t.end_date || '')}</span> · ` : ''}${t.archived_at ? '已归档' : taskStatus(t.status).label}${left !== null && left >= 0 ? ` · 剩 <span class="num">${left}</span> 天` : ''}</div></div>
      <span class="sp"></span>
      <button class="btn primary" data-act="edit">✎ 编辑项目</button>
      ${t.archived_at ? '<button class="btn small" data-act="restore">恢复</button>' : '<button class="btn small" data-act="archive">归档</button>'}</div>
    ${ratio !== null ? `<div><div class="span"><span>待办完成 <span class="num">${done.length}/${todos.length}</span></span><span>竖线 = 今天</span></div>
      <div class="prog" style="height:8px"><i style="width:${todos.length ? (done.length / todos.length) * 100 : 0}%"></i><span class="today" style="left:${ratio * 100}%"></span></div></div>` : ''}
    ${t.description ? `<p style="color:var(--ink-2);max-width:65ch;white-space:pre-wrap">${esc(t.description)}</p>` : ''}
    <div><div class="sec-h">联系人</div>
      <div class="contacts">${contacts.map(c => `<span class="contact"><span class="av">${esc(c.name[0])}</span>${esc(c.name)}<span class="kind">${esc(c.org || contactKind(c.kind))}</span></span>`).join('') || '<span class="hint">还没有联系人，点「编辑项目」添加</span>'}</div></div>
    <div class="group"><div class="group-h"><b>待办</b><span class="num">${open.length}</span></div>
      <div id="cap-box"></div>
      <div class="list">${open.map(x => todoRow(x, { hideTask: true })).join('') || '<div class="empty">没有未完成的待办</div>'}</div>
      ${done.length ? `<button class="group-h" data-act="done"><b>${showDone ? '▾' : '▸'} 已完成</b><span class="num">${done.length}</span></button>
        ${showDone ? `<div class="list">${done.map(x => todoRow(x, { hideTask: true })).join('')}</div>` : ''}` : ''}</div>
    <div class="group"><div class="group-h"><b>材料收集</b><span class="num">${cols.length}</span></div>
      <div class="list">${cols.map(c => `<a class="item plain" href="#/collections?c=${c.id}" style="color:inherit;text-decoration:none"><div class="t-title">${esc(c.title)}</div><div class="t-side num">${c.done}/${c.total}</div></a>`).join('')}
        <a class="item plain" href="#/collections?new=${t.id}" style="color:var(--accent);text-decoration:none"><div>＋ 发起材料收集</div><span></span></a></div></div>
    <div style="display:flex;justify-content:flex-end"><button class="btn small danger" data-act="delete">删除项目</button></div>
  </div>`;

  mountCapture(root.querySelector('#cap-box'), { taskId: t.id });

  root.onclick = async e => {
    const chk = e.target.closest('[data-check]');
    if (chk) { e.stopPropagation(); const x = todos.find(y => String(y.id) === chk.dataset.check); await setStatus(x, x.status === 'done' ? 'todo' : 'done', { task: t }); return; }
    const row = e.target.closest('[data-todo]');
    if (row) { openTodo(row.dataset.todo); return; }
    const a = e.target.closest('[data-act]'); if (!a) return;
    switch (a.dataset.act) {
      case 'edit': openTaskForm(t); break;
      case 'archive': await archiveTask(t.id); toast('已归档，可在「项目」页底部恢复'); break;
      case 'restore': await restoreTask(t.id); toast('已恢复'); break;
      case 'done': showDone = !showDone; mount(root, { id }); break;
      case 'delete':
        if (await confirmSheet(`删除项目「${t.title}」？下面的待办会保留，但不再归属任何项目。`, '删除', true)) { await removeTask(t.id); toast('已删除'); go('/tasks'); }
        break;
    }
  };
}
