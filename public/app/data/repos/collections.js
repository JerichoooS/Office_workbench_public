// collections.js — 材料收集：向多个对象（部门/科室/单位/人）收材料，记录谁交了

import { table, run, changed } from '../db.js';

/** 列表（带 done/total 统计） */
export async function listCollections({ taskId, includeClosed = true } = {}) {
  let q = table('collections').select('*');
  if (taskId !== undefined) q = q.eq('task_id', taskId);
  if (!includeClosed) q = q.is('closed_at', null);
  const cols = await run(q.order('due_at', { ascending: true, nullsFirst: false }));
  if (!cols.length) return cols;
  const targets = await run(table('collection_targets').select('collection_id,submitted_at').in('collection_id', cols.map(c => c.id)));
  return cols.map(c => {
    const ts = targets.filter(t => String(t.collection_id) === String(c.id));
    return { ...c, total: ts.length, done: ts.filter(t => t.submitted_at).length };
  });
}

export async function getCollection(id) {
  const c = await run(table('collections').select('*').eq('id', id).maybeSingle());
  if (!c) return null;
  c.targets = await run(table('collection_targets').select('*').eq('collection_id', id).order('id', { ascending: true }));
  return c;
}

export async function createCollection({ title, task_id = null, due_at = null, note = null }, targets = []) {
  const [c] = await run(table('collections').insert({ title: title.trim(), task_id, due_at, note }).select());
  if (targets.length) await run(table('collection_targets').insert(targets.map(t => ({ collection_id: c.id, name: t.name, kind: t.kind || 'department', contact_id: t.contact_id || null }))));
  changed('collections');
  return c;
}

export async function updateCollection(id, patch) { await run(table('collections').update(patch).eq('id', id)); changed('collections'); }
export async function removeCollection(id) { await run(table('collections').delete().eq('id', id)); changed('collections'); }

export async function addTarget(collectionId, { name, kind = 'department', contact_id = null }) {
  await run(table('collection_targets').insert({ collection_id: collectionId, name: name.trim(), kind, contact_id }));
  changed('collections');
}
export async function removeTarget(id) { await run(table('collection_targets').delete().eq('id', id)); changed('collections'); }
export async function toggleTarget(target) {
  await run(table('collection_targets').update({ submitted_at: target.submitted_at ? null : new Date().toISOString() }).eq('id', target.id));
  changed('collections');
}

/** 催办文字（用户复制后自己发）；截止时间已过就说「已于…截止」，不再说「将于」 */
export function chaserText(c, now = new Date()) {
  const pend = (c.targets || []).filter(t => !t.submitted_at);
  if (!pend.length) return '';
  const due = c.due_at ? new Date(c.due_at) : null;
  const when = due ? `${due <= now ? '已于' : '将于'} ${due.getMonth() + 1}月${due.getDate()}日（周${'日一二三四五六'[due.getDay()]}）${String(due.getHours()).padStart(2, '0')}:${String(due.getMinutes()).padStart(2, '0')} 截止` : '正在收集';
  return `各位同事好：\n「${c.title}」${when}，目前尚未收到 ${pend.map(t => t.name).join('、')} 的材料，请尽快报送。谢谢！`;
}
