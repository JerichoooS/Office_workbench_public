// todos.js — 待办、进展记录、提醒
// 状态流转的副作用都在这里处理（视图只调用 setStatus）：
//   → done    写 completed_at；有重复规则则生成下一条（下一条已经有了就不再生成）
//   → waiting 写 waiting_since，并排下一次催办提醒
//   离开 waiting 清掉未发送的催办
//   状态没变（再点一次「已完成」、双击勾选）什么都不写：完成时间保持原样，不会跳进本周周报
// 写入排队：同一条待办的写操作（updateTodo / updateTodoWith / setStatus）依次执行。
//   连点子步骤、两处同时改：用 updateTodoWith(id, row => patch) 基于库里最新的行算改动，不会互相覆盖。
// 提醒只排将来的：时刻已过的一律不插入（否则服务器的 6 小时补发会立刻推一条「补发」）。
// 第二阶段（云库执行了 005，features.phase2()）：
//   - 新建带 client_id（前端生成）：同一条重发（没信号时记下、联网补存；超时后重试）不会变成两条
//   - 删除的待办自动进「最近删除」（数据库触发器）；程序自己撤回的（撤销完成时删掉自动生成的下一次）不进
//   - 进展分手写和自动留痕（addLog 的 kind）；每条待办最多一条待发催办（数据库唯一约束兜底）
// 自动留痕（用户确认，第二阶段）：改状态（applyStatus）、改截止（changeDue）、点「已催」（markNudged）各记一条浅色小字；
//   没执行 005 时不记（addLog 自动跳过），其余照常。撤销「完成」时连同这条一起删掉。
// 改截止一律走 changeDue：提醒按原来的意思跟着改（截止前 N 分钟重算、到点跟着截止走、指定时刻不动、过去的删掉）。

import { table, run, runAll, changed } from '../db.js';
import { phase2 } from '../features.js';
import { getSettings } from './settings.js';
import { bumpTags } from './tags.js';
import { contactById } from './contacts.js';
import { DEFAULT_REMINDER } from '../schema.js';
import { beforeDueAt, nextNudgeAt, nextRepeatDue, repeatSkipped } from '../../core/schedule.js';
import { ymd, hm, startOfDay, addDays } from '../../core/dates.js';
import { toast } from '../../core/dom.js';

const COLS = '*';

/** 默认列表里带上近多少天完成的（看板「已完成」列、首页「今天完成」、负一屏「本周完成」都在这个范围里） */
export const RECENT_DONE_DAYS = 14;

const listOrder = q => q.order('due_at', { ascending: true, nullsFirst: false }).order('sort_order', { ascending: true }).order('id', { ascending: true });
/** 与 listOrder 相同的排序（两次查询合并后用）：截止早的在前、没截止的最后，再按 sort_order、id */
const t0 = v => (v ? new Date(v).getTime() : Infinity);
const byListOrder = (a, b) => (t0(a.due_at) - t0(b.due_at)) || ((a.sort_order || 0) - (b.sort_order || 0)) || (Number(a.id) - Number(b.id));

/**
 * 列表：分页读完（云端可能限制单次返回的行数，超出部分会被悄悄截掉，表现为「待办不见了」）。
 * 默认只读「没完成的 + 近 RECENT_DONE_DAYS 天完成的」——不再把多年来完成过的都读一遍。需要更多的调用方用 done 指定：
 *   done: 'all'                 全部已完成（全部待办页搜索、显示已完成；项目详情）
 *   done: 'none'                不要已完成的
 *   done: { since: Date }       这个时刻之后完成的（周报：那一周的周一起）
 *   done: { dueFrom, dueTo }    截止在这段时间里的已完成（日历：显示的这几周）
 * taskId：只要这个项目的（null = 零星待办）；taskIds：只要这几个项目的。
 * 没完成的和已完成的分两次查（模拟库没有 or），合并后按原来的顺序排。
 */
export async function listTodos({ taskId, taskIds, done } = {}) {
  if (taskIds && !taskIds.length) return [];
  const read = where => runAll(() => {
    let q = table('todos').select(COLS);
    if (taskId !== undefined) q = taskId === null ? q.is('task_id', null) : q.eq('task_id', taskId);
    if (taskIds) q = q.in('task_id', taskIds);
    return listOrder(where(q));
  }, 1000);
  if (done === 'all') return read(q => q);
  const open = read(q => q.neq('status', 'done'));
  if (done === 'none') return open;
  const iso = d => new Date(d).toISOString();
  const fin = done && done.dueFrom ? read(q => q.eq('status', 'done').gte('due_at', iso(done.dueFrom)).lt('due_at', iso(done.dueTo)))
    : read(q => q.eq('status', 'done').gte('completed_at', iso(done && done.since ? done.since : addDays(startOfDay(new Date()), -RECENT_DONE_DAYS))));
  const [a, b] = await Promise.all([open, fin]);
  return [...a, ...b].sort(byListOrder);
}

export async function getTodo(id) {
  return run(table('todos').select(COLS).eq('id', id).maybeSingle());
}

// ---------- 写入队列：同一条待办的写操作一个接一个（前一个成功或失败后再开始下一个） ----------
const queues = new Map();
function queued(id, fn) {
  const key = String(id), p = (queues.get(key) || Promise.resolve()).catch(() => {}).then(fn);
  queues.set(key, p);
  p.catch(() => {}).finally(() => { if (queues.get(key) === p) queues.delete(key); });
  return p;
}
const write = async (id, patch) => (await run(table('todos').update(patch).eq('id', id).select()))[0];

/** 前端生成的唯一编号（client_id） */
export const newClientId = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);

/**
 * 新建待办。remind: 'default' 用设置里的默认提醒；'at_time' 到点提醒；'none' 不提醒。
 * data.client_id：同一条重发时传同一个（离线补存）；不传自动生成。库里已有同一 client_id = 上次其实存上了，直接返回那一条。
 * 撞上「重复待办同一天只能一条」时抛出 code 'WB_DUP_REPEAT'（不弹提示，调用方决定怎么说）。
 */
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
  if (phase2()) row.client_id = data.client_id || newClientId();
  let todo;
  try {
    [todo] = await run(table('todos').insert(row).select(), { expect: row.client_id ? ['23505'] : [] });
  } catch (e) {
    if (!e.expected) throw e;
    const [had] = await run(table('todos').select(COLS).eq('client_id', row.client_id).limit(1));
    if (!had) { const x = new Error('已经有一条同样的重复待办（同一天）'); x.code = 'WB_DUP_REPEAT'; x.handled = true; throw x; }
    // 上次已经存上了（只是回应没回来）：补上那时没来得及排的提醒
    if (!(await run(table('reminders').select('id').eq('todo_id', had.id).limit(1))).length) {
      try { await createReminders([had], { remind }); if (had.status === 'waiting') await scheduleNudge(had, task); } catch (x) { console.warn('提醒没排上', x); }
    }
    changed('todos');
    return had;
  }
  // 待办已经建好：后面的提醒、催办失败不再往外抛（run 已提示原因）。以前一抛错，输入框里的字还在，用户再按回车就多一条重复待办
  try {
    await createReminders([todo], { remind });
    if (todo.status === 'waiting') await scheduleNudge(todo, task);
  } catch (e) { console.warn('提醒没排上', e); }
  await bumpTags(row.tags);   // 标签计数放最后，且从不抛错：提醒不受它影响
  changed('todos');
  return todo;
}

/** 直接写入 patch（排队执行）。patch 若是根据界面上的旧行算出来的，请改用 updateTodoWith */
export function updateTodo(id, patch, { silent = false } = {}) {
  return queued(id, async () => { const row = await write(id, patch); if (!silent) changed('todos'); return row; });
}

/**
 * 读-改-写（排队执行）：先从库里读出这条待办的最新行，build(row) 返回要改的字段（可以是 async；返回空 = 不改），再写回。
 *   例：勾第 i 个子步骤  updateTodoWith(id, t => ({ checklist: (t.checklist || []).map((c, j) => j === i ? { ...c, done: true } : c) }))
 * 写的时候带上读到的 updated_at（库里有触发器维护）：读完之后别的设备又改过，就写不进去，重读重算（最多 3 次，之后直接写）。
 * 返回写后的行；没有改动返回当前行；待办已被删除返回 null。
 */
export function updateTodoWith(id, build, { silent = false } = {}) {
  return queued(id, async () => {
    for (let i = 0; ; i++) {
      const cur = await getTodo(id);
      if (!cur) return null;
      const patch = await build(cur);
      if (!patch || !Object.keys(patch).length) return cur;
      let q = table('todos').update(patch).eq('id', id);
      if (cur.updated_at && i < 3) q = q.eq('updated_at', cur.updated_at);
      const [row] = await run(q.select());
      if (row) { if (!silent) changed('todos'); return row; }
    }
  });
}

/** 删除待办（进展、提醒一起删）。第二阶段自动进「最近删除」；trash: false = 程序自己撤回的，不进最近删除 */
export async function removeTodo(id, { trash = true } = {}) {
  await run(table('todos').delete().eq('id', id));
  if (!trash && phase2()) await run(table('trash').delete().eq('kind', 'todo').eq('item_id', id)).catch(() => {});
  changed('todos');
}

/**
 * 切换状态（含副作用）。todo 只用到 id：以库里的最新状态为准（界面上的行可能是旧的）。
 * 返回 { row, next, skipped, log }：next 自动生成的下一次（重复待办）；skipped 补交逾期时跳过了几期；log 这次的自动留痕（撤销时删）。
 * repeat: false = 完成时不生成下一次（项目收尾「一并完成」：项目已经结束，这个系列也到此为止）。
 * 同一条待办、同一目标状态的调用还没跑完时，直接复用那一次（双击勾选不会跑两遍）；其余调用排队依次执行。
 */
const inflight = new Map();
export function setStatus(todo, status, { task = null, repeat = true } = {}) {
  const key = `${todo.id}:${status}`;
  if (!inflight.has(key)) inflight.set(key, queued(todo.id, () => applyStatus(todo.id, status, task, repeat)).finally(() => inflight.delete(key)));
  return inflight.get(key);
}

/** 状态变化的留痕文字 */
function statusText(cur, status) {
  if (status === 'waiting') { const w = contactById(cur.waiting_on); return w ? `转为等待 · 等 ${w.name}` : '转为等待'; }
  if (status === 'doing') return '转为进行中';
  if (status === 'done') return '完成';
  return cur.status === 'done' ? '恢复为未完成' : '改回未开始';
}

/** 自动留痕：失败不影响已经保存的改动（run 已提示原因）。没执行 005 时 addLog 直接返回 null */
const autoLog = (id, text, kind) => addLog(id, text, { kind, silent: true }).catch(e => { console.warn('自动留痕没记上', e); return null; });

async function applyStatus(id, status, task, repeat = true) {
  const cur = await getTodo(id);
  if (!cur) return { row: null, next: null, skipped: 0, log: null };
  if (cur.status === status) {   // 状态没变：不写；等待中只补上缺失的下一次催办
    if (status === 'waiting' && !(await run(table('reminders').select('id').eq('todo_id', id).eq('kind', 'nudge').is('sent_at', null))).length) await scheduleNudge(cur, task);
    return { row: cur, next: null, skipped: 0, log: null };
  }
  const now = new Date().toISOString();
  const row = await write(id, { status, completed_at: status === 'done' ? now : null, waiting_since: status === 'waiting' ? now : null });

  await run(table('reminders').delete().eq('todo_id', id).eq('kind', 'nudge').is('sent_at', null));
  if (status === 'waiting') await scheduleNudge(row, task);

  // 重复待办：下一次 = 原截止日之后、不早于今天的第一期（补交逾期的那期，今天这期照常保留）；中间跳过的期数提示用户
  let next = null, skipped = 0;
  if (status === 'done' && cur.repeat_rule && repeat) {
    const due = nextRepeatDue(cur.repeat_rule, cur.due_at);
    if (due && !(await hasOccurrence(cur, due))) {
      try {
        next = await createTodo({ ...cur, client_id: null, status: 'todo', due_at: due, checklist: (cur.checklist || []).map(c => ({ ...c, done: false })), waiting_on: null }, { remind: 'default', task });
        skipped = repeatSkipped(cur.repeat_rule, cur.due_at, due);
      } catch (e) { if (e.code !== 'WB_DUP_REPEAT') throw e; }   // 下一次已经有了（别的设备刚生成）：当作已生成，不提示
    }
  }
  const log = await autoLog(id, statusText(cur, status), 'status');
  changed('todos');
  return { row, next, skipped, log };
}

/**
 * 撤销「完成」（列表勾选后提示条里的「撤销」）：恢复原来的状态、完成时间、等待开始时间；
 * 删掉这次的「完成」留痕和自动生成的下一次（程序撤回的，不进最近删除）；原来在等待的重新排催办。
 * prev = 勾选前界面上的行；r = setStatus 的返回值。
 */
export function undoDone(prev, r, { task = null } = {}) {
  return queued(prev.id, async () => {
    await write(prev.id, { status: prev.status, completed_at: prev.completed_at || null, waiting_since: prev.waiting_since || null });
    if (prev.status === 'waiting') await scheduleNudge(prev, task);
    if (r && r.log) await run(table('todo_logs').delete().eq('id', r.log.id));
    if (r && r.next) await removeTodo(r.next.id, { trash: false });
    changed('todos');
  });
}

/**
 * 「已催」（用户确认 小规则 2）：记一条「已催」留痕，丢掉待发的催办，从现在起按节奏排下一次。
 * 只对等待中的待办有效（库里已不在等待返回 null）。返回 { at: 下次催办时间, log }。没执行 005 时不记留痕，照样重排。
 */
export function markNudged(todo, { task = null } = {}) {
  return queued(todo.id, async () => {
    const cur = await getTodo(todo.id);
    if (!cur || cur.status !== 'waiting') return null;
    await run(table('reminders').delete().eq('todo_id', cur.id).eq('kind', 'nudge').is('sent_at', null));
    const at = await scheduleNudge(cur, task, { from: new Date() });
    const w = contactById(cur.waiting_on);
    const log = await autoLog(cur.id, w ? `已催 · ${w.name}` : '已催', 'nudged');
    changed('todos');
    return { at, log };
  });
}

/** 重复系列的标识：同标题、同项目、同重复规则（规则里键的顺序不影响） */
export const seriesKey = t => JSON.stringify([t.title, t.task_id == null ? null : String(t.task_id), t.repeat_rule ? Object.keys(t.repeat_rule).sort().map(k => [k, t.repeat_rule[k]]) : null]);

/** 下一次是否已经有了：同一系列、还没完成、截止在同一天（完成→恢复→再完成、两台设备各点一次时不再重复生成） */
async function hasOccurrence(todo, due) {
  let q = table('todos').select('id,title,task_id,repeat_rule,due_at').eq('title', todo.title).neq('status', 'done').neq('id', todo.id);
  q = todo.task_id == null ? q.is('task_id', null) : q.eq('task_id', todo.task_id);
  const day = d => (d ? ymd(new Date(d)) : null);
  return (await run(q)).some(r => seriesKey(r) === seriesKey(todo) && day(r.due_at) === day(due));
}

// ---------- 提醒 ----------
export async function listReminders(todoId) {
  return run(table('reminders').select('*').eq('todo_id', todoId).order('fire_at', { ascending: true }));
}

/** 一条待办按 remind 方式应有的提醒（截止前 / 到点），已过的时刻不要 */
function reminderRows(t, remind, def, now) {
  if (!t.due_at || remind === 'none' || t.status === 'done') return [];
  const r = remind === 'at_time' && !t.due_all_day ? { kind: 'at_time', offset_minutes: null, at: new Date(t.due_at) }
    : def && def.minutes != null ? { kind: 'before_due', offset_minutes: def.minutes, at: beforeDueAt(t.due_at, t.due_all_day, def.minutes) } : null;
  return r && r.at > now ? [{ todo_id: t.id, kind: r.kind, offset_minutes: r.offset_minutes, fire_at: r.at.toISOString() }] : [];
}

/** 给刚建好的待办排提醒（只插入，不删旧的；新建、套用项目时用）。remind 同 createTodo */
export async function createReminders(todos, { remind = 'default' } = {}) {
  if (remind === 'none' || !todos.some(t => t.due_at)) return;
  const s = await getSettings();
  const def = DEFAULT_REMINDER.find(r => r.v === s.default_reminder), now = new Date();
  const rows = todos.flatMap(t => reminderRows(t, remind, def, now));
  if (rows.length) await run(table('reminders').insert(rows));
}

/** 按截止时间重建「截止前」「到点」提醒（会丢掉手动加的提醒；改截止请用 changeDue） */
export async function resetReminders(todo, { remind = 'default' } = {}) {
  await run(table('reminders').delete().eq('todo_id', todo.id).in('kind', ['before_due', 'at_time']).is('sent_at', null));
  await createReminders([todo], { remind });
}

/** 手动加一条提醒。时刻已过就不加（返回 false）：服务器会把它当成错过的提醒立刻「补发」 */
export async function addReminder(todoId, kind, fireAt, offset = null) {
  const at = new Date(fireAt);
  if (!(at > new Date())) { toast('这个时间已经过了，没有添加提醒'); return false; }
  await run(table('reminders').insert({ todo_id: todoId, kind, fire_at: at.toISOString(), offset_minutes: offset }));
  changed('reminders');
  return true;
}
export async function removeReminder(id) {
  await run(table('reminders').delete().eq('id', id));
  changed('reminders');
}

/** 排下一次催办。from 省略 = 从开始等待算起（点了「已催」时传现在）。已经有一条待发的（服务器刚续排过）就不再排，返回那条的时间 */
export async function scheduleNudge(todo, task, { from } = {}) {
  const at = nextNudgeAt(task, from || todo.waiting_since || new Date());
  try {
    await run(table('reminders').insert({ todo_id: todo.id, kind: 'nudge', fire_at: at.toISOString() }), { expect: ['23505'] });
  } catch (e) {
    if (!e.expected) throw e;
    const [cur] = await run(table('reminders').select('fire_at').eq('todo_id', todo.id).eq('kind', 'nudge').is('sent_at', null).limit(1));
    return cur ? new Date(cur.fire_at) : at;
  }
  return at;
}

// ---------- 改截止（所有改截止的地方都走这里：详情的日期框、今天 / 明天 / 下周一、全天 / 有时刻、清除） ----------
const MERGE_MS = 10 * 60000;   // 10 分钟内连着改截止（点错了马上再改）只留一条留痕
const sameMinute = (a, b) => !!a && !!b && Math.abs(new Date(a) - new Date(b)) < 60000;

/** 截止的说法：10月25日 / 10月25日 17:00（不是今年的带年份） */
function dueWords(at, allDay) {
  const d = new Date(at);
  return `${d.getFullYear() !== new Date().getFullYear() ? d.getFullYear() + '年' : ''}${d.getMonth() + 1}月${d.getDate()}日${allDay ? '' : ' ' + hm(d)}`;
}
/** 改截止的留痕文字；看起来没变（只差秒）返回 null */
function dueText(cur, row) {
  if (!row.due_at) return cur.due_at ? '去掉了截止时间' : null;
  const w = dueWords(row.due_at, row.due_all_day);
  if (!cur.due_at) return `截止定为 ${w}`;
  return w === dueWords(cur.due_at, cur.due_all_day) ? null : `截止改为 ${w}`;
}

/**
 * 改截止时间（含全天 / 有时刻切换、清除）。patch：{ due_at, due_all_day }，due_all_day 省略 = 不变；全天的统一存当天 23:59。
 * 副作用：提醒按原来的意思跟着改（shiftReminders）；记一条「截止改为 …」留痕（10 分钟内连着改合并成一条）。
 * 返回写后的行；没有变化返回当前行；待办已被删除返回 null。
 */
export function changeDue(todo, { due_at, due_all_day } = {}) {
  return queued(todo.id, async () => {
    const cur = await getTodo(todo.id);
    if (!cur) return null;
    const allDay = due_all_day === undefined ? !!cur.due_all_day : !!due_all_day;
    const due = due_at ? new Date(due_at) : null;
    if (due && allDay) due.setHours(23, 59, 0, 0);
    if ((cur.due_at ? new Date(cur.due_at).getTime() : null) === (due ? due.getTime() : null) && !!cur.due_all_day === allDay) return cur;
    const row = await write(cur.id, { due_at: due ? due.toISOString() : null, due_all_day: allDay });
    try { await shiftReminders(cur, row); } catch (e) { console.warn('提醒没跟着改', e); }
    try { await logDue(cur, row); } catch (e) { console.warn('改截止的留痕没记上', e); }
    changed('todos');
    return row;
  });
}

/**
 * 截止改了，提醒按原来的意思跟着改（第二阶段修正：以前改截止会把手动加的提醒全删掉，切换全天 / 有时刻也不重算）：
 *   「截止前 N 分钟」（before_due，有 offset）→ 按新截止用 beforeDueAt 重算（全天的照 09:00 规则）
 *   「到点」（at_time，正好是原截止时刻；全天的是截止当天 09:00）→ 跟到新截止（全天的 = 截止当天 09:00）
 *   指定时刻的 at_time → 不动
 *   没有截止了、或新时刻已经过了 → 删掉（不排过去的提醒）；两条撞到同一分钟 → 只留一条
 *   原来没有截止 → 按设置里的默认提醒排（和新建一样）
 *   原截止的提醒已经发过了（逾期后往后挪）→ 按同样的意思给新截止再排一次
 */
async function shiftReminders(cur, row) {
  const all = await run(table('reminders').select('*').eq('todo_id', cur.id).in('kind', ['before_due', 'at_time']).order('fire_at', { ascending: true }));
  const now = new Date();
  // 某条提醒对某个截止的时刻；undefined = 不跟截止走（指定时刻）
  const onTime = (r, t) => r.kind === 'at_time' && !!t.due_at && (sameMinute(r.fire_at, t.due_at) || (t.due_all_day && sameMinute(r.fire_at, beforeDueAt(t.due_at, true, 0))));
  const timeFor = (r, t) => {
    if (r.kind === 'before_due' && r.offset_minutes != null) return t.due_at ? beforeDueAt(t.due_at, t.due_all_day, r.offset_minutes) : null;
    return undefined;
  };
  const target = r => {
    const x = timeFor(r, row); if (x !== undefined) return x;
    if (onTime(r, cur)) return row.due_at ? (row.due_all_day ? beforeDueAt(row.due_at, true, 0) : new Date(row.due_at)) : null;
    return undefined;
  };
  const meaning = r => (r.kind === 'before_due' ? 'b' + r.offset_minutes : 'at');
  const taken = new Set(), have = new Set(), del = [], upd = [];
  const minute = d => Math.floor(new Date(d).getTime() / 60000);
  const pending = all.filter(x => !x.sent_at).map(r => [r, target(r)]);
  pending.forEach(([r, at]) => { if (at === undefined) taken.add(minute(r.fire_at)); });   // 指定时刻的先占位，不动
  for (const [r, at] of pending) {
    if (at === undefined) continue;
    if (!at || at <= now || taken.has(minute(at))) { del.push(r.id); continue; }
    taken.add(minute(at)); have.add(meaning(r));
    if (!sameMinute(at, r.fire_at)) upd.push([r.id, at]);
  }
  const add = [];
  const push = (kind, offset, at) => { if (at && at > now && !taken.has(minute(at))) { taken.add(minute(at)); add.push({ todo_id: row.id, kind, offset_minutes: offset, fire_at: at.toISOString() }); } };
  if (row.due_at && row.status !== 'done') {
    if (!cur.due_at) {
      const s = await getSettings();
      reminderRows(row, 'default', DEFAULT_REMINDER.find(x => x.v === s.default_reminder), now).forEach(x => push(x.kind, x.offset_minutes, new Date(x.fire_at)));
    } else {
      for (const r of all.filter(x => x.sent_at)) {   // 为原截止发过的提醒（时刻对得上原截止）
        if (have.has(meaning(r))) continue;
        const was = timeFor(r, cur);
        if (!(was ? sameMinute(was, r.fire_at) : onTime(r, cur))) continue;
        have.add(meaning(r));
        push(r.kind, r.offset_minutes, target(r));
      }
    }
  }
  if (del.length) await run(table('reminders').delete().in('id', del));
  for (const [id, at] of upd) await run(table('reminders').update(phase2() ? { fire_at: at.toISOString(), retry_at: null, attempts: 0 } : { fire_at: at.toISOString() }).eq('id', id));
  if (add.length) await run(table('reminders').insert(add));
}

/** 改截止的留痕；10 分钟内上一条也是改截止 → 改写那一条（先定了截止又马上清掉 → 那条删掉） */
async function logDue(cur, row) {
  let text = dueText(cur, row);
  if (!text || !phase2()) return null;
  const [last] = await run(table('todo_logs').select('*').eq('todo_id', cur.id).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1));
  if (!last || last.kind !== 'due' || Date.now() - new Date(last.created_at) > MERGE_MS) return addLog(cur.id, text, { kind: 'due', silent: true });
  if (/^截止定为/.test(last.content)) {
    if (!row.due_at) { await run(table('todo_logs').delete().eq('id', last.id)); return null; }
    text = text.replace(/^截止改为/, '截止定为');
  }
  const [log] = await run(table('todo_logs').update({ content: text, created_at: new Date().toISOString() }).eq('id', last.id).select());
  return log || null;
}

// ---------- 进展记录 ----------
export async function listLogs(todoId) {
  return run(table('todo_logs').select('*').eq('todo_id', todoId).order('created_at', { ascending: true }));
}
/**
 * 记一条进展。kind：'note' 手写（默认）；自动留痕 'status' 状态变化、'due' 改期、'nudged' 已催。
 * 自动留痕只在第二阶段（云库有 kind 列）才记——旧库上记成普通进展会和手写的混在一起。返回写入的行（没写返回 null）。
 */
export async function addLog(todoId, content, { kind = 'note', silent = false } = {}) {
  if (kind !== 'note' && !phase2()) return null;
  const row = { todo_id: todoId, content: content.trim() };
  if (kind !== 'note') row.kind = kind;
  const [log] = await run(table('todo_logs').insert(row).select());
  if (!silent) changed('logs');
  return log || null;
}
