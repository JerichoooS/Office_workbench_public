// restore.js — 从备份找回（设置 › 数据与备份）
// 备份 = 「导出 JSON」的文件，或第二阶段的云端快照（格式相同：{ app: '个人工作台', format, tables: { 表名: [行…] } }）。
// 规则（用户确认）：只补回「现在缺少」的行，按 id 比对（标签按名称）；现有的行一律不覆盖、不改动。
//   - 按外键顺序插入、用原来的 id：联系人 → 项目 → 项目联系人 → 待办 → 进展 → 提醒 → 材料收集 → 收集对象 → 标签
//   - 指向的行已经不在了：能置空的置空（待办的项目、等待对象；收集的项目；收集对象的联系人；项目的套用来源）；
//     不能置空的（进展、提醒、项目联系人、收集对象缺了上级）就不补
//   - 提醒只补「这次找回的待办」的、还没发、时间还没到的（现有待办的提醒以现在的为准，免得补回改期前的旧提醒）；每条待办最多一条待发催办
//   - 和现有数据撞唯一约束的不补：同一 client_id、同一对「项目-联系人」、同一天同一条重复待办
//   - 不碰 user_settings（设置以现在的为准）
// planRestore 是纯函数（用例在 server/test/trust.test.mjs）；applyRestore 负责写入，写之前再读一次现状。

import { table, run, changed } from './db.js';
import { loadAll } from './export.js';
import { listContacts } from './repos/contacts.js';
import { listTags } from './repos/tags.js';
import { scheduleNudge } from './repos/todos.js';

export const RESTORE_ORDER = ['contacts', 'tasks', 'task_contacts', 'todos', 'todo_logs', 'reminders', 'collections', 'collection_targets', 'tags'];

/** 读进来的 JSON 是不是本应用的导出 / 快照；不是就抛错（说人话） */
export function checkBackup(obj) {
  if (!obj || typeof obj !== 'object' || obj.app !== '个人工作台' || !obj.tables || typeof obj.tables !== 'object' || Array.isArray(obj.tables)) {
    throw new Error('这不是工作台导出的备份文件。请选「完整备份（JSON）」导出的文件。');
  }
  return obj.tables;
}

// 与 005 的「重复待办同一天只能一条」相同的判断：同标题、同项目、同规则（键的顺序不算）、北京时间同一天、都没完成
const canon = v => (v && typeof v === 'object' && !Array.isArray(v) ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v));
const bjDay = ts => (ts ? new Date(new Date(ts).getTime() + 8 * 3600000).toISOString().slice(0, 10) : null);
const repeatKey = t => (t.repeat_rule != null && t.status !== 'done' && t.due_at ? [t.title, t.task_id == null ? 0 : String(t.task_id), canon(t.repeat_rule), bjDay(t.due_at)].join('|') : null);

/**
 * 算出要补回哪些行。backup / current：{ 表名: [行…] }。返回 { tables: { 表名: [要插入的行] }, counts, total, summary }。
 * 返回的行已去掉 owner_id（由数据库填）；悬空的引用已置空。
 */
export function planRestore(backup, current, now = new Date()) {
  const B = t => (Array.isArray(backup[t]) ? backup[t].filter(r => r && typeof r === 'object') : []);
  const C = t => (Array.isArray(current[t]) ? current[t] : []);
  const have = Object.fromEntries(RESTORE_ORDER.map(t => [t, new Set(C(t).map(r => String(r.id)))]));
  const has = (t, id) => id != null && have[t].has(String(id));
  const strip = r => { const { owner_id, ...x } = r; return { ...x }; };
  const missing = t => {
    const seen = new Set();
    return B(t).filter(r => r.id != null && !has(t, r.id) && !seen.has(String(r.id)) && seen.add(String(r.id))).map(strip);
  };
  const out = {};
  const keep = (t, rows) => { out[t] = rows; rows.forEach(r => have[t].add(String(r.id))); };
  const nullDangling = (rows, col, t) => rows.forEach(r => { if (r[col] != null && !has(t, r[col])) r[col] = null; });

  keep('contacts', missing('contacts'));
  const tasks = missing('tasks');
  keep('tasks', tasks);
  nullDangling(tasks, 'source_task_id', 'tasks');   // 套用来源：同表，等这次的都加进来再判断

  const pairs = new Set(C('task_contacts').map(r => `${r.task_id}:${r.contact_id}`));
  keep('task_contacts', missing('task_contacts').filter(r => {
    const k = `${r.task_id}:${r.contact_id}`;
    if (!has('tasks', r.task_id) || !has('contacts', r.contact_id) || pairs.has(k)) return false;
    pairs.add(k); return true;
  }));

  const clientIds = new Set(C('todos').map(r => r.client_id).filter(Boolean));
  const repeats = new Set(C('todos').map(repeatKey).filter(Boolean));
  const todos = missing('todos').filter(r => {
    nullDangling([r], 'task_id', 'tasks');
    nullDangling([r], 'waiting_on', 'contacts');
    if (r.client_id && clientIds.has(r.client_id)) return false;   // 同一条记录已经在（换了 id 存过）
    const k = repeatKey(r);
    if (k && repeats.has(k)) return false;
    if (r.client_id) clientIds.add(r.client_id);
    if (k) repeats.add(k);
    return true;
  });
  keep('todos', todos);
  const newTodos = new Set(todos.map(r => String(r.id)));

  keep('todo_logs', missing('todo_logs').filter(r => has('todos', r.todo_id)));

  const nudged = new Set(C('reminders').filter(r => r.kind === 'nudge' && !r.sent_at).map(r => String(r.todo_id)));
  keep('reminders', missing('reminders').filter(r => {
    if (!newTodos.has(String(r.todo_id)) || r.sent_at || r.failed_at || !(new Date(r.fire_at) > now)) return false;
    if (r.kind === 'nudge') { if (nudged.has(String(r.todo_id))) return false; nudged.add(String(r.todo_id)); }
    return true;
  }));

  const cols = missing('collections');
  nullDangling(cols, 'task_id', 'tasks');
  keep('collections', cols);
  const newCols = new Set(cols.map(r => String(r.id)));
  const targets = missing('collection_targets').filter(r => has('collections', r.collection_id));
  nullDangling(targets, 'contact_id', 'contacts');
  keep('collection_targets', targets);

  // 标签按名称比对；原 id 已被占用就让数据库重新编号
  const names = new Set(C('tags').map(r => r.name));
  out.tags = B('tags').filter(r => r.name && !names.has(r.name) && names.add(r.name)).map(r => {
    const x = strip(r);
    if (x.id == null || has('tags', x.id)) delete x.id; else have.tags.add(String(x.id));
    return x;
  });

  const counts = Object.fromEntries(RESTORE_ORDER.map(t => [t, out[t].length]));
  // 说明文字里把进展、提醒、收集对象分成「跟着找回的上级一起回来的」和「补到现有上级下面的」
  counts.logsWithTodos = out.todo_logs.filter(r => newTodos.has(String(r.todo_id))).length;
  counts.targetsWithCols = out.collection_targets.filter(r => newCols.has(String(r.collection_id))).length;
  const total = RESTORE_ORDER.reduce((s, t) => s + counts[t], 0);
  return { tables: out, counts, total, summary: summarize(counts) };
}

/** 一句话说清楚能找回什么，如「待办 3 条（含进展 5 条）、联系人 1 个」；什么都没有返回 '' */
export function summarize(c) {
  const p = [];
  const logsAlone = (c.todo_logs || 0) - (c.logsWithTodos || 0), targetsAlone = (c.collection_targets || 0) - (c.targetsWithCols || 0);
  if (c.todos) {
    const inner = [c.logsWithTodos && `进展 ${c.logsWithTodos} 条`, c.reminders && `提醒 ${c.reminders} 条`].filter(Boolean);
    p.push(`待办 ${c.todos} 条${inner.length ? `（含${inner.join('、')}）` : ''}`);
  }
  if (logsAlone > 0) p.push(`进展 ${logsAlone} 条`);
  if (c.tasks) p.push(`项目 ${c.tasks} 个`);
  if (c.contacts) p.push(`联系人 ${c.contacts} 个`);
  if (c.collections) p.push(`材料收集 ${c.collections} 个${c.targetsWithCols ? `（含收集对象 ${c.targetsWithCols} 个）` : ''}`);
  if (targetsAlone > 0) p.push(`收集对象 ${targetsAlone} 个`);
  if (c.tags) p.push(`标签 ${c.tags} 个`);
  if (c.task_contacts && !c.tasks) p.push(`项目联系人 ${c.task_contacts} 个`);
  return p.join('、');
}

/** 读现状并算好方案（预览用） */
export async function prepareRestore(backupTables) {
  return planRestore(backupTables, await loadAll());
}

/** 写入：按外键顺序，每批 200 行；这一批有行刚被别处建了（或上级刚被删）就逐行写、跳过冲突的。返回实际写入的条数 */
export async function applyRestore(plan) {
  const done = {};
  for (const t of RESTORE_ORDER) {
    const rows = plan.tables[t] || [];
    done[t] = 0;
    for (let i = 0; i < rows.length; i += 200) done[t] += await insertBatch(t, rows.slice(i, i + 200));
  }
  // 找回的「等待他人」没有带回待发的催办（原来的已经过时间了）：补排一次，否则不会再自动催
  const nudged = new Set((plan.tables.reminders || []).filter(r => r.kind === 'nudge').map(r => String(r.todo_id)));
  for (const t of (plan.tables.todos || []).filter(x => x.status === 'waiting' && !nudged.has(String(x.id)))) {
    try { await scheduleNudge(t, null); } catch (e) { console.warn('催办没排上', e); }
  }
  await Promise.all([listContacts(true), listTags(true)]).catch(() => {});   // 这两样有缓存
  changed('restore');
  const total = RESTORE_ORDER.reduce((s, t) => s + done[t], 0);
  return { counts: done, total };
}

async function insertBatch(t, rows) {
  const opts = { expect: ['23505', '23503'] };
  try { await run(table(t).insert(rows), opts); return rows.length; }
  catch (e) {
    if (!e.expected) throw e;
    let n = 0;
    for (const r of rows) {
      try { await run(table(t).insert(r), opts); n++; } catch (x) { if (!x.expected) throw x; }
    }
    return n;
  }
}
