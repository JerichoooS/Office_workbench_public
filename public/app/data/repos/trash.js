// trash.js — 最近删除（第二阶段：云库执行了 005，features.phase2() 为真才有这张表）
// 删除待办、收集对象时，数据库触发器先存一份到 trash（待办：{ todo, logs, reminders }；收集对象：{ target, collection_title }），
// 30 天前的自动清掉。这里负责列出、找到刚删的那条、放回去。
// 放回规则（用户确认）：
//   待办：用原来的 id 和各列放回（owner_id 由数据库填）；所属项目、等待对象已经不在了就置空；
//         进展按原 id 放回；提醒只放回时间还没到的；等待中却没有待发催办的补排一次；最后删掉这条 trash。
//   收集对象：所属收集还在才放回；收集已经删了就直说，不放回。
//   放回两次不会变成两条：主键冲突（23505）= 已经放回过了。

import { table, run, changed, saveFailed } from '../db.js';
import { scheduleNudge } from './todos.js';
import { getTask } from './tasks.js';
import { toast } from '../../core/dom.js';

export const KEEP_DAYS = 30;
export const TRASH_KIND = { todo: '待办', collection_target: '收集对象' };
const TABLE_OF = { todo: 'todos', collection_target: 'collection_targets' };

/** 最近 30 天删除的，新的在前 */
export async function listTrash() {
  const since = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString();
  return run(table('trash').select('*').gte('deleted_at', since).order('deleted_at', { ascending: false }).order('id', { ascending: false }));
}

/** 某条刚删掉的（撤销用）：同一 id 删过多次时取最新的一份 */
export async function findTrash(kind, itemId) {
  const [row] = await run(table('trash').select('*').eq('kind', kind).eq('item_id', itemId).order('deleted_at', { ascending: false }).limit(1));
  return row || null;
}

const exists = async (tbl, id) => id != null && (await run(table(tbl).select('id').eq('id', id).limit(1))).length > 0;
const strip = row => { const { owner_id, ...rest } = row || {}; return rest; };   // owner_id 由数据库按当前登录用户填

/** 插入一行；主键或唯一约束冲突返回 false（不弹提示） */
async function insertOnce(tbl, row) {
  try { await run(table(tbl).insert(row), { expect: ['23505'] }); return true; }
  catch (e) { if (e.expected) return false; throw e; }
}
/** 插入多行：整批冲突时逐行插，跳过已经有的 */
async function insertMissing(tbl, rows) {
  if (!rows.length) return 0;
  try { await run(table(tbl).insert(rows), { expect: ['23505'] }); return rows.length; }
  catch (e) {
    if (!e.expected) throw e;
    let n = 0;
    for (const r of rows) if (await insertOnce(tbl, r)) n++;
    return n;
  }
}

async function restoreTodo(t) {
  const d = t.data || {}, todo = strip(d.todo);
  if (todo.id == null) return { ok: false, message: '这条删除记录不完整，没法恢复' };
  const notes = [];
  if (todo.task_id != null && !(await exists('tasks', todo.task_id))) { todo.task_id = null; notes.push('原来的项目已经删了，放进了零星待办'); }
  if (todo.waiting_on != null && !(await exists('contacts', todo.waiting_on))) { todo.waiting_on = null; notes.push('等待对象已经删了'); }
  let already = false;
  if (!(await insertOnce('todos', todo))) {
    if (!(await exists('todos', todo.id))) {
      // 冲突的不是主键：同一个 client_id 的已经在了（离线补存又存了一份）= 等于已经恢复；否则是「重复待办同一天只能一条」
      const same = todo.client_id && (await run(table('todos').select('id').eq('client_id', todo.client_id).limit(1)))[0];
      if (!same) return { ok: false, message: '同一天已经有一条同样的重复待办，没有恢复' };
      await run(table('trash').delete().eq('id', t.id));
      changed('todos');
      return { ok: true, already: true, id: same.id, message: '这条已经在了' };
    }
    already = true;
  }
  // 进展：按原 id 补上缺的（上次恢复中途断网，再点一次也能补齐）
  const logs = (d.logs || []).map(strip);
  if (logs.length) {
    const have = new Set((await run(table('todo_logs').select('id').eq('todo_id', todo.id))).map(x => String(x.id)));
    await insertMissing('todo_logs', logs.filter(l => !have.has(String(l.id))));
  }
  if (!already) {
    const now = Date.now();
    const rems = (d.reminders || []).map(strip).filter(r => !r.sent_at && new Date(r.fire_at).getTime() > now);
    await insertMissing('reminders', rems);
    if (todo.status === 'waiting' && !rems.some(r => r.kind === 'nudge')) {
      try { await scheduleNudge(todo, todo.task_id ? await getTask(todo.task_id) : null); } catch (e) { console.warn('催办没排上', e); }
    }
  }
  await run(table('trash').delete().eq('id', t.id));
  changed('todos');
  if (already) return { ok: true, already: true, id: todo.id, message: '这条已经恢复过了' };
  return { ok: true, id: todo.id, message: notes.length ? `已恢复（${notes.join('；')}）` : '已恢复' };
}

async function restoreTarget(t) {
  const d = t.data || {}, tg = strip(d.target);
  if (tg.id == null) return { ok: false, message: '这条删除记录不完整，没法恢复' };
  if (!(await exists('collections', tg.collection_id))) {
    return { ok: false, gone: true, message: `「${d.collection_title || '原来的收集'}」已经删除了，「${t.title}」没地方放回去` };
  }
  if (tg.contact_id != null && !(await exists('contacts', tg.contact_id))) tg.contact_id = null;
  const fresh = await insertOnce('collection_targets', tg);
  await run(table('trash').delete().eq('id', t.id));
  changed('collections');
  return { ok: true, already: !fresh, id: tg.id, collection_id: tg.collection_id, message: fresh ? '已恢复' : '这条已经恢复过了' };
}

/** 放回一条 trash 记录。返回 { ok, message, already?, gone?, id? }；网络等错误照常抛出（run 已提示） */
export async function restoreTrash(row) {
  if (row.kind === 'todo') return restoreTodo(row);
  if (row.kind === 'collection_target') return restoreTarget(row);
  return { ok: false, message: '不认识的删除记录' };
}

const busy = new Map();   // 撤销按钮连点：同一条只跑一次
/** 撤销刚才的删除：找到 trash 里的那一份并放回 */
export function restoreDeleted(kind, itemId) {
  const key = `${kind}:${itemId}`;
  if (!busy.has(key)) {
    busy.set(key, (async () => {
      const row = await findTrash(kind, itemId);
      if (row) return restoreTrash(row);
      if (await exists(TABLE_OF[kind], itemId)) return { ok: true, already: true, id: itemId, message: '这条已经恢复过了' };
      return { ok: false, message: '没找到删除记录，没法撤销' };
    })().finally(() => busy.delete(key)));
  }
  return busy.get(key);
}

/** 删除后的提示条：「已删除」+「撤销」（停留 5 秒）。opened(r)：恢复后提示条上「打开」按钮做什么（可不传） */
export function toastDeleted(kind, itemId, { msg = '已删除', opened = null } = {}) {
  toast(msg, {
    action: {
      label: '撤销',
      onClick: async () => {
        try {
          const r = await restoreDeleted(kind, itemId);
          toast(r.message, r.ok && opened ? { action: { label: '打开', onClick: () => opened(r) } } : {});
        } catch (e) { saveFailed(e); }
      },
    },
  });
}
