// snapshots.js — 每日云端快照（第二阶段）：服务器每天凌晨给每个用户存一份完整数据，保留 14 天。
// 前端只读（列表不取 data 列，点「下载」「找回」时才取那一份）。格式与「导出 JSON」的 tables 相同。

import { table, run } from '../db.js';

export const SNAPSHOT_DAYS = 14;

/** 新的在前：{ id, day, bytes, created_at } */
export async function listSnapshots() {
  return run(table('snapshots').select('id,day,bytes,created_at').order('day', { ascending: false }));
}

/** 取一份完整的快照（含 data） */
export async function getSnapshot(id) {
  return run(table('snapshots').select('*').eq('id', id).maybeSingle());
}
