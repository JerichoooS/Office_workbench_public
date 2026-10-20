// settings.js — 用户设置（user_settings，每人一行，主键 owner_id）

import { table, run, changed } from '../db.js';

let cache = null;

/** 读取设置；首次使用自动建默认行 */
export async function getSettings(force = false) {
  if (cache && !force) return cache;
  let row = await run(table('user_settings').select('*').maybeSingle());
  if (!row) row = await run(table('user_settings').insert({}).select().single());
  cache = normalize(row);
  return cache;
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
