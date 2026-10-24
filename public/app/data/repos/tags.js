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

// 标签计数只用于补全排序，失败不该打扰用户：这里不走 run()（它会弹错误提示），出错抛给 bumpTags 统一记到控制台
const quiet = async b => { const r = await b; if (r && r.error) throw Object.assign(new Error(r.error.message || '标签操作失败'), { code: r.error.code }); return r ? r.data : null; };
const fresh = () => quiet(table('tags').select('id,name,use_count'));

/**
 * 使用了这些标签：计数 +1，新标签自动入库。从不抛错。
 * 以前这里会抛错（例如另一台设备刚建了同名标签 → 唯一约束冲突），新建待办在插入之后中断：提醒没建、界面报错，
 * 用户再按一次回车就多出一条重复待办。现在冲突时重新读标签库改为计数 +1，其他错误只记日志。
 */
export async function bumpTags(names) {
  if (!names || !names.length) return;
  try {
    let list = await fresh();
    for (const name of new Set(names)) {
      let t = list.find(x => x.name === name);
      if (!t) {
        try { await quiet(table('tags').insert({ name, use_count: 1 })); continue; } catch (e) { if (e.code !== '23505') throw e; }
        list = await fresh(); t = list.find(x => x.name === name);   // 别的设备刚建了同名标签
        if (!t) continue;
      }
      await quiet(table('tags').update({ use_count: t.use_count + 1 }).eq('id', t.id));
    }
  } catch (e) { console.warn('标签计数没更新（不影响待办本身）：', e.message); }
  cache = null;
}
