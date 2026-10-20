// tasks.js — 项目（大）：起止时间、联系人、归档/恢复、套用历史项目

import { table, run, changed } from '../db.js';
import { ymd, parseYmd, startOfDay, addDays } from '../../core/dates.js';

/** 列表：默认不含已归档 */
export async function listTasks({ archived = false } = {}) {
  let q = table('tasks').select('*');
  q = archived ? q.not('archived_at', 'is', null) : q.is('archived_at', null);
  return run(q.order('end_date', { ascending: true, nullsFirst: false }).order('id', { ascending: true }));
}

export async function getTask(id) {
  return run(table('tasks').select('*').eq('id', id).maybeSingle());
}

export async function taskContactIds(taskId) {
  const rows = await run(table('task_contacts').select('contact_id').eq('task_id', taskId));
  return rows.map(r => r.contact_id);
}

export async function createTask(data, contactIds = []) {
  const [task] = await run(table('tasks').insert({
    title: data.title.trim(), description: data.description || null,
    start_date: data.start_date || null, end_date: data.end_date || null,
    status: data.status || 'in_progress', tags: data.tags || [], source_task_id: data.source_task_id || null,
  }).select());
  await setTaskContacts(task.id, contactIds);
  changed('tasks');
  return task;
}

export async function updateTask(id, patch, contactIds) {
  await run(table('tasks').update(patch).eq('id', id));
  if (contactIds) await setTaskContacts(id, contactIds);
  changed('tasks');
}

export async function setTaskContacts(taskId, ids) {
  const cur = await taskContactIds(taskId);
  const add = ids.filter(id => !cur.some(c => String(c) === String(id)));
  const del = cur.filter(c => !ids.some(id => String(c) === String(id)));
  if (del.length) await run(table('task_contacts').delete().eq('task_id', taskId).in('contact_id', del));
  if (add.length) await run(table('task_contacts').insert(add.map(contact_id => ({ task_id: taskId, contact_id }))));
}

export async function archiveTask(id) { await updateTask(id, { archived_at: new Date().toISOString() }); }
export async function restoreTask(id) { await updateTask(id, { archived_at: null, status: 'in_progress' }); }
export async function removeTask(id) { await run(table('tasks').delete().eq('id', id)); changed('tasks'); }

/** 结束日期已过的项目自动归档（打开应用时调用一次） */
export async function autoArchive() {
  const today = ymd(new Date());
  const due = await run(table('tasks').select('id,end_date').is('archived_at', null).lt('end_date', today));
  for (const t of due) await run(table('tasks').update({ archived_at: new Date().toISOString(), status: 'done' }).eq('id', t.id));
  if (due.length) changed('tasks');
  return due.length;
}

/** 搜索历史项目（含已归档），用于「套用」 */
export async function searchTasks(q) {
  const rows = await run(table('tasks').select('*').ilike('title', `%${q}%`).order('start_date', { ascending: false, nullsFirst: false }).limit(10));
  return rows;
}

/**
 * 套用历史项目：复制联系人、待办（标题/子步骤/标签/优先级/重复规则）、材料收集清单；
 * 所有日期按「新开始日 - 旧开始日」整体平移。
 */
export async function cloneTask(sourceId, { title, start_date }) {
  const src = await getTask(sourceId);
  const shift = src.start_date && start_date ? Math.round((parseYmd(start_date) - parseYmd(src.start_date)) / 86400000) : 0;
  const mv = d => (d ? ymd(addDays(parseYmd(d), shift)) : null);
  const mvTs = ts => (ts ? new Date(new Date(ts).getTime() + shift * 86400000).toISOString() : null);
  const contactIds = await taskContactIds(sourceId);
  const task = await createTask({ title: title || src.title, description: src.description, start_date: start_date || src.start_date, end_date: mv(src.end_date), tags: src.tags, source_task_id: src.id }, contactIds);

  const todos = await run(table('todos').select('*').eq('task_id', sourceId));
  if (todos.length) await run(table('todos').insert(todos.map(t => ({
    task_id: task.id, title: t.title, notes: t.notes, priority: t.priority, due_at: mvTs(t.due_at), due_all_day: t.due_all_day,
    repeat_rule: t.repeat_rule, tags: t.tags, checklist: (t.checklist || []).map(c => ({ ...c, done: false })), status: 'todo',
  }))));
  const cols = await run(table('collections').select('*').eq('task_id', sourceId));
  for (const c of cols) {
    const [nc] = await run(table('collections').insert({ task_id: task.id, title: c.title, note: c.note, due_at: mvTs(c.due_at) }).select());
    const targets = await run(table('collection_targets').select('*').eq('collection_id', c.id));
    if (targets.length) await run(table('collection_targets').insert(targets.map(x => ({ collection_id: nc.id, contact_id: x.contact_id, name: x.name, kind: x.kind }))));
  }
  changed('tasks');
  return { task, shift, todoCount: todos.length };
}

/** 时间进度 0~1 与剩余天数 */
export function timeInfo(task, now = new Date()) {
  if (!task.start_date || !task.end_date) return { ratio: null, left: null };
  const s = parseYmd(task.start_date), e = addDays(parseYmd(task.end_date), 1);
  const ratio = Math.min(Math.max((now - s) / (e - s), 0), 1);
  const left = Math.round((parseYmd(task.end_date) - startOfDay(now)) / 86400000);
  return { ratio, left };
}

/** 所有项目-联系人关系（快速记录猜测归属项目时用） */
export async function listAllTaskContacts() {
  return run(table('task_contacts').select('task_id,contact_id'));
}
