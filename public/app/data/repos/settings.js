// settings.js — 用户设置（user_settings，每人一行，主键 owner_id）

import { table, run, changed } from '../db.js';

let cache = null, loading = null;

/** 读取设置；首次使用自动建默认行。同时多处调用只读一次（避免新用户第一次打开时插两行、第二行撞主键报错） */
export function getSettings(force = false) {
  if (cache && !force) return Promise.resolve(cache);
  if (!loading) loading = (async () => {
    let row = await run(table('user_settings').select('*').maybeSingle());
    if (!row) row = await run(table('user_settings').insert({}).select().single());
    cache = normalize(row);
    return cache;
  })().finally(() => { loading = null; });
  return loading;
}

export async function updateSettings(patch) {
  const rows = await run(table('user_settings').update(patch).not('owner_id', 'is', null).select());
  cache = normalize(rows && rows[0] ? rows[0] : { ...cache, ...patch });
  changed('settings');
  return cache;
}

// time 列可能返回 '08:30:00'，界面统一用 'HH:MM'
function normalize(r) {
  return { ...r, morning_time: (r.morning_time || '08:30').slice(0, 5), evening_time: (r.evening_time || '18:00').slice(0, 5) };
}

export const cachedSettings = () => cache;
