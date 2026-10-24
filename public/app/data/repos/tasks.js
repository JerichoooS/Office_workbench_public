// tasks.js — 项目（大）：起止时间、联系人、归档/恢复、到期收尾、套用历史项目
// 到期先收尾再归档（用户确认 决定 4 + 小规则 9）：过了结束日、待办都做完了才自动归档；
//   还有没做完的 → 首页收尾卡 + 项目详情顶部同样一块，给出「顺延结束日 / 移到零星待办 / 一并完成 / 停止催办」，处理完没剩下的就归档。
//   等待中的待办默认照常催办，「停止催办」才停。

import { table, run, runAll, changed } from '../db.js';
import { ymd, parseYmd, startOfDay, addDays } from '../../core/dates.js';
import { createReminders, seriesKey, setStatus } from './todos.js';

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
/**
 * 恢复已归档的项目：必须给新的结束日期（不早于今天）——结束日期还在过去的话，下次打开应用：
 * 待办都做完了 autoArchive 又会把它归档；还有没做完的，首页出收尾卡。
 */
export async function restoreTask(id, endDate) {
  if (!endDate || endDate < ymd(new Date())) throw new Error('恢复项目需要一个不早于今天的结束日期');
  await updateTask(id, { archived_at: null, status: 'in_progress', end_date: endDate });
}
export async function removeTask(id) { await run(table('tasks').delete().eq('id', id)); changed('tasks'); }

/** 过了结束日、还没归档的项目 */
const ended = () => run(table('tasks').select('*').is('archived_at', null).lt('end_date', ymd(new Date())).order('end_date', { ascending: true }).order('id', { ascending: true }));
/** 这些项目里没做完的待办（按项目分组） */
async function openTodosOf(ids) {
  if (!ids.length) return new Map();
  const rows = await runAll(() => table('todos').select('*').in('task_id', ids).neq('status', 'done')
    .order('due_at', { ascending: true, nullsFirst: false }).order('id', { ascending: true }));
  const out = new Map(ids.map(id => [String(id), []]));
  rows.forEach(t => { const k = String(t.task_id); if (out.has(k)) out.get(k).push(t); });
  return out;
}
const archiveNow = id => run(table('tasks').update({ archived_at: new Date().toISOString(), status: 'done' }).eq('id', id));

/** 结束日期已过、待办都做完了的项目自动归档（打开应用时调用一次）；还有没做完的留着收尾（listWrapups）。返回归档了几个 */
export async function autoArchive() {
  const due = await ended();
  const open = await openTodosOf(due.map(t => t.id));
  const clear = due.filter(t => !open.get(String(t.id)).length);
  for (const t of clear) await archiveNow(t.id);
  if (clear.length) changed('tasks');
  return clear.length;
}

/**
 * 待收尾的项目：过了结束日、没归档、还有没做完的待办。结束早的在前。
 * 每项 { task, open: 没做完的待办, waiting: 其中等待中的, nudging: 等待中且还有待发催办的条数 }
 */
export async function listWrapups() {
  const due = await ended();
  if (!due.length) return [];
  const open = await openTodosOf(due.map(t => t.id));
  const list = due.filter(t => open.get(String(t.id)).length);
  const waitIds = list.flatMap(t => open.get(String(t.id)).filter(x => x.status === 'waiting').map(x => x.id));
  const nudges = waitIds.length ? await run(table('reminders').select('todo_id').eq('kind', 'nudge').is('sent_at', null).in('todo_id', waitIds)) : [];
  const nudged = new Set(nudges.map(r => String(r.todo_id)));
  return list.map(task => {
    const rows = open.get(String(task.id)), waiting = rows.filter(x => x.status === 'waiting');
    return { task, open: rows, waiting, nudging: waiting.filter(x => nudged.has(String(x.id))).length };
  });
}
/** 一个项目的收尾信息（项目详情顶部用）；不需要收尾返回 null */
export async function wrapupOf(taskId) {
  return (await listWrapups()).find(w => String(w.task.id) === String(taskId)) || null;
}

/** 收尾之后：没有没做完的了就归档。返回是否归档了 */
async function archiveIfClear(id) {
  const t = await getTask(id);
  if (!t || t.archived_at || !t.end_date || t.end_date >= ymd(new Date())) return false;
  if ((await openTodosOf([id])).get(String(id)).length) return false;
  await archiveNow(id);
  return true;
}

/** 收尾 · 顺延结束日（不早于今天）。项目照常进行 */
export async function extendTask(id, endDate) {
  if (!endDate || endDate < ymd(new Date())) throw new Error('新的结束日期不能早于今天');
  await updateTask(id, { end_date: endDate, status: 'in_progress' });
}
/** 收尾 · 没做完的移到零星待办（task_id 置空），然后归档。返回 { moved, archived } */
export async function moveOpenToInbox(id) {
  const rows = (await openTodosOf([id])).get(String(id));
  if (rows.length) await run(table('todos').update({ task_id: null }).in('id', rows.map(t => t.id)));
  const archived = await archiveIfClear(id);
  changed('todos'); changed('tasks');
  return { moved: rows.length, archived };
}
/** 收尾 · 一并完成：逐条标为完成（各记一条「完成」留痕）；重复待办不再生成下一次（项目已经结束）。然后归档。返回 { done, archived } */
export async function completeOpen(id) {
  const task = await getTask(id);
  const rows = (await openTodosOf([id])).get(String(id));
  for (const t of rows) await setStatus(t, 'done', { task, repeat: false });
  const archived = await archiveIfClear(id);
  changed('tasks');
  return { done: rows.length, archived };
}
/** 收尾 · 停止催办：删掉这个项目里等待中待办的待发催办（待办仍在等待，不归档）。返回停了几条 */
export async function stopNudging(id) {
  const rows = (await openTodosOf([id])).get(String(id)).filter(t => t.status === 'waiting');
  if (rows.length) await run(table('reminders').delete().eq('kind', 'nudge').is('sent_at', null).in('todo_id', rows.map(t => t.id)));
  changed('reminders');
  return rows.length;
}
/** 项目过了结束日（详情里不再自动补排催办：用户可能在收尾时点了「停止催办」） */
export const taskEnded = task => !!(task && task.end_date && task.end_date < ymd(new Date()));

/** 搜索历史项目（含已归档），用于「套用」 */
export async function searchTasks(q) {
  const rows = await run(table('tasks').select('*').ilike('title', `%${q}%`).order('start_date', { ascending: false, nullsFirst: false }).limit(10));
  return rows;
}

/**
 * 套用历史项目：复制联系人、待办（标题/子步骤/标签/优先级/重复规则）、材料收集清单；
 * 所有日期按「新开始日 - 旧开始日」整体平移。
 * 重复待办每完成一次就生成下一条，历史项目里同一系列有好几条：每个系列只复制最新的一条（否则日报会变成几条并行的重复待办）。
 * 复制出的待办按设置里的默认提醒排提醒（与新建待办相同），平移后已过的时刻不排。
 */
export async function cloneTask(sourceId, { title, start_date }) {
  const src = await getTask(sourceId);
  const shift = src.start_date && start_date ? Math.round((parseYmd(start_date) - parseYmd(src.start_date)) / 86400000) : 0;
  const mv = d => (d ? ymd(addDays(parseYmd(d), shift)) : null);
  const mvTs = ts => (ts ? new Date(new Date(ts).getTime() + shift * 86400000).toISOString() : null);
  const contactIds = await taskContactIds(sourceId);
  const task = await createTask({ title: title || src.title, description: src.description, start_date: start_date || src.start_date, end_date: mv(src.end_date), tags: src.tags, source_task_id: src.id }, contactIds);

  const all = await run(table('todos').select('*').eq('task_id', sourceId));
  const later = (a, b) => new Date(a.due_at || 0) - new Date(b.due_at || 0) || +a.id - +b.id;   // 截止晚的在后；截止相同按 id
  const latest = new Map();   // 重复系列 → 最新的一条
  for (const t of all) { const k = seriesKey(t), p = latest.get(k); if (t.repeat_rule && (!p || later(t, p) > 0)) latest.set(k, t); }
  const todos = all.filter(t => !t.repeat_rule || latest.get(seriesKey(t)) === t);
  if (todos.length) {
    const rows = await run(table('todos').insert(todos.map(t => ({
      task_id: task.id, title: t.title, notes: t.notes, priority: t.priority, due_at: mvTs(t.due_at), due_all_day: t.due_all_day,
      repeat_rule: t.repeat_rule, tags: t.tags, checklist: (t.checklist || []).map(c => ({ ...c, done: false })), status: 'todo',
    }))).select());
    await createReminders(rows || [], { remind: 'default' }).catch(e => console.warn('套用的待办提醒没排上', e));
  }
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
