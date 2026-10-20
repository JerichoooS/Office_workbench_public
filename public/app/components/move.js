// move.js — 零星待办里的待办「归入项目」：弹出项目列表，点一下就挪进去

import { esc, openSheet, closeSheet, toast } from '../core/dom.js';
import { listTasks } from '../data/repos/tasks.js';
import { updateTodo } from '../data/repos/todos.js';

export async function openMoveSheet(todoId, title = '', onDone) {
  const tasks = await listTasks();
  const el = openSheet(`<div class="sheet-head"><b>归入项目</b><span class="sp"></span><button class="btn small" data-x>取消</button></div>
    ${title ? `<div class="hint">「${esc(title)}」</div>` : ''}
    <div class="list">${tasks.map(t => `<button class="item plain" data-to="${t.id}" style="width:100%;text-align:left"><div class="t-title">${esc(t.title)}</div><span class="t-side">${esc(t.end_date ? t.end_date.slice(5) + ' 结束' : '')}</span></button>`).join('') || '<div class="empty">还没有进行中的项目</div>'}</div>`, { label: '归入项目' });
  el.onclick = async e => {
    if (e.target.closest('[data-x]')) { closeSheet(); return; }
    const b = e.target.closest('[data-to]'); if (!b) return;
    await updateTodo(todoId, { task_id: b.dataset.to });
    closeSheet();
    toast('已归入「' + tasks.find(t => String(t.id) === b.dataset.to).title + '」');
    if (onDone) onDone();
  };
}
