// contacts.js — 联系对象：人 / 部门 / 科室 / 单位

import { table, run, changed } from '../db.js';

let cache = null;

export async function listContacts(force = false) {
  if (cache && !force) return cache;
  cache = await run(table('contacts').select('*').order('name', { ascending: true }));
  return cache;
}

export const contactById = id => (cache || []).find(c => String(c.id) === String(id)) || null;

export async function createContact({ name, kind = 'person', org = null, phone = null, note = null }) {
  const [row] = await run(table('contacts').insert({ name: name.trim(), kind, org, phone, note }).select());
  cache = null; await listContacts();
  changed('contacts');
  return row;
}

export async function updateContact(id, patch) {
  await run(table('contacts').update(patch).eq('id', id));
  cache = null; await listContacts();
  changed('contacts');
}

export async function removeContact(id) {
  await run(table('contacts').delete().eq('id', id));
  cache = null; await listContacts();
  changed('contacts');
}

/** 按名称找，没有就新建（快速记录、收集对象时用） */
export async function ensureContact(name, kind = 'person') {
  const list = await listContacts();
  return list.find(c => c.name === name.trim()) || createContact({ name, kind });
}

/**
 * 合并联系人：把 fromId 的所有引用改指向 toId，然后删除 fromId。
 * 引用包括：项目联系人（重复的关系直接去掉）、待办的等待对象、材料收集对象。
 */
export async function mergeContact(fromId, toId) {
  if (String(fromId) === String(toId)) return;
  const links = await run(table('task_contacts').select('id,task_id').eq('contact_id', fromId));
  const targetTasks = (await run(table('task_contacts').select('task_id').eq('contact_id', toId))).map(x => String(x.task_id));
  for (const l of links) {
    if (targetTasks.includes(String(l.task_id))) await run(table('task_contacts').delete().eq('id', l.id));
    else await run(table('task_contacts').update({ contact_id: toId }).eq('id', l.id));
  }
  await run(table('todos').update({ waiting_on: toId }).eq('waiting_on', fromId));
  await run(table('collection_targets').update({ contact_id: toId }).eq('contact_id', fromId));
  await run(table('contacts').delete().eq('id', fromId));
  cache = null; await listContacts();
  changed('contacts');
}
