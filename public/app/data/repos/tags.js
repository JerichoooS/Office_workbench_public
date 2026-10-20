// tags.js — 标签库：按使用次数排序，用于自动补全

import { table, run } from '../db.js';

let cache = null;

export async function listTags(force = false) {
  if (cache && !force) return cache;
  cache = await run(table('tags').select('*').order('use_count', { ascending: false }));
  return cache;
}

/** 本地规则推荐：标题里出现的已有标签 + 常用标签（不接 AI 也可用） */
export async function suggestTags(text, exclude = [], n = 4) {
  const list = await listTags();
  const hit = list.filter(t => text.includes(t.name));
  const rest = list.filter(t => !hit.includes(t));
  return [...hit, ...rest].map(t => t.name).filter(x => !exclude.includes(x)).slice(0, n);
}

/** 使用了这些标签：计数 +1，新标签自动入库 */
export async function bumpTags(names) {
  if (!names || !names.length) return;
  const list = await listTags();
  for (const name of names) {
    const t = list.find(x => x.name === name);
    if (t) await run(table('tags').update({ use_count: t.use_count + 1 }).eq('id', t.id));
    else await run(table('tags').insert({ name, use_count: 1 }));
  }
  cache = null;
}
