// todos.js — 待办、进展记录、提醒
// 状态流转的副作用都在这里处理（视图只调用 setStatus）：
//   → done    写 completed_at；有重复规则则生成下一条
//   → waiting 写 waiting_since，并排下一次催办提醒
//   离开 waiting 清掉未发送的催办

import { table, run, changed } from '../db.js';
import { getSettings } from './settings.js';
import { bumpTags } from './tags.js';
import { DEFAULT_REMINDER } from '../schema.js';
import { beforeDueAt, nextNudgeAt, nextRepeatDue } from '../../core/schedule.js';

const COLS = '*';

export async function listTodos({ includeDone = true, taskId } = {}) {
  let q = table('todos').select(COLS);
  if (!includeDone) q = q.neq('status', 'done');
  if (taskId !== undefined) q = taskId === null ? q.is('task_id', null) : q.eq('task_id', taskId);
  return run(q.order('due_at', { ascending: true, nullsFirst: false }).order('sort_order', { ascending: true }).order('id', { ascending: true }));
}

export async function getTodo(id) {
  return run(table('todos').select(COLS).eq('id', id).maybeSingle());
}

/** 新建待办。remind: 'default' 用设置里的默认提醒；'at_time' 到点提醒；'none' 不提醒 */
export async function createTodo(data, { remind = 'default', task = null } = {}) {
  const row = {
    title: data.title.trim(),
    task_id: data.task_id || null,
    status: data.status || 'todo',
    priority: data.priority ?? null,
    due_at: data.due_at ? new Date(data.due_at).toISOString() : null,
    due_all_day: data.due_all_day !== false,
    waiting_on: data.waiting_on || null,
    waiting_since: data.status === 'waiting' ? new Date().toISOString() : null,
    repeat_rule: data.repeat_rule || null,
    checklist: data.checklist || [],
    tags: data.tags || [],
    notes: data.notes || null,
  };
  const [todo] = await run(table('todos').insert(row).select());
  await bumpTags(row.tags);
  await resetReminders(todo, { remind, task });
  if (todo.status === 'waiting') await scheduleNudge(todo, task);
  changed('todos');
  return todo;
}

export async function updateTodo(id, patch, { silent = false } = {}) {
  const [row] = await run(table('todos').update(patch).eq('id', id).select());
  if (!silent) changed('todos');
  return row;
}

export async function removeTodo(id) {
  await run(table('todos').delete().eq('id', id));
  changed('todos');
}

/** 切换状态（含副作用） */
export async function setStatus(todo, status, { task = null } = {}) {
  const now = new Date().toISOString();
  const patch = { status };
  patch.completed_at = status === 'done' ? now : null;
  if (status === 'waiting' && todo.status !== 'waiting') patch.waiting_since = now;
  if (status !== 'waiting') patch.waiting_since = null;
  const row = await updateTodo(todo.id, patch, { silent: true });

  await run(table('reminders').delete().eq('todo_id', todo.id).eq('kind', 'nudge').is('sent_at', null));
  if (status === 'waiting') await scheduleNudge(row, task);

  let next = null;
  if (status === 'done' && todo.repeat_rule && todo.status !== 'done') {
    const due = nextRepeatDue(todo.repeat_rule, todo.due_at);
    next = await createTodo({ ...todo, status: 'todo', due_at: due, checklist: (todo.checklist || []).map(c => ({ ...c, done: false })), waiting_on: null }, { remind: 'default' });
  }
  changed('todos');
  return { row, next };
}

// ---------- 提醒 ----------
export async function listReminders(todoId) {
  return run(table('reminders').select('*').eq('todo_id', todoId).order('fire_at', { ascending: true }));
}

/** 按截止时间重建「截止前」「到点」提醒（改了截止时间后调用） */
export async function resetReminders(todo, { remind = 'default' } = {}) {
  await run(table('reminders').delete().eq('todo_id', todo.id).in('kind', ['before_due', 'at_time']).is('sent_at', null));
  if (!todo.due_at || remind === 'none' || todo.status === 'done') return;
  const rows = [];
  if (remind === 'at_time' && !todo.due_all_day) rows.push({ todo_id: todo.id, kind: 'at_time', fire_at: todo.due_at });
  if (remind === 'default' || remind === 'at_time') {
    const s = await getSettings();
    const def = DEFAULT_REMINDER.find(r => r.v === s.default_reminder);
    if (def && def.minutes != null && !(remind === 'at_time' && !todo.due_all_day)) {
      const at = beforeDueAt(todo.due_at, todo.due_all_day, def.minutes);
      if (at && at > new Date()) rows.push({ todo_id: todo.id, kind: 'before_due', offset_minutes: def.minutes, fire_at: at.toISOString() });
    }
  }
  if (rows.length) await run(table('reminders').insert(rows));
}

export async function addReminder(todoId, kind, fireAt, offset = null) {
  await run(table('reminders').insert({ todo_id: todoId, kind, fire_at: new Date(fireAt).toISOString(), offset_minutes: offset }));
  changed('reminders');
}
export async function removeReminder(id) {
  await run(table('reminders').delete().eq('id', id));
  changed('reminders');
}

export async function scheduleNudge(todo, task) {
  const at = nextNudgeAt(task, todo.waiting_since || new Date());
  await run(table('reminders').insert({ todo_id: todo.id, kind: 'nudge', fire_at: at.toISOString() }));
  return at;
}

// ---------- 进展记录 ----------
export async function listLogs(todoId) {
  return run(table('todo_logs').select('*').eq('todo_id', todoId).order('created_at', { ascending: true }));
}
export async function addLog(todoId, content) {
  await run(table('todo_logs').insert({ todo_id: todoId, content: content.trim() }));
  changed('logs');
}
