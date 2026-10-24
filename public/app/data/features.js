// features.js — 云库执行到了哪一步（db/migrations），决定新功能开不开
// 第二阶段的功能（最近删除、离线记一条、自动留痕、云端快照…）要先在云库执行 005_phase2.sql。
// 没执行时这些功能自动不出现，其余照常可用：前端先上线、数据库后改，也不会出错。
// 启动时读一次（main.js）；读不到（断网）用上次记住的结果。

import { run } from './db.js';

const KEY = 'wb-schema';
let versions = null;

export async function loadFeatures() {
  try {
    const v = await run(window.cloud.database.rpc('wb_schema_version'), { expect: ['PGRST202', '42883', '404'] });
    versions = Array.isArray(v) ? v.map(String) : [];
  } catch (e) {
    if (e && e.expected) versions = [];   // 函数不存在 = 还没执行 005
    else { try { versions = JSON.parse(localStorage.getItem(KEY)) || []; } catch (_) { versions = []; } return versions; }
  }
  try { localStorage.setItem(KEY, JSON.stringify(versions)); } catch (_) { /* 无痕模式 */ }
  return versions;
}

/** 某个数据库改动执行过没有，如 has('005') */
export const has = v => !!versions && versions.includes(v);
/** 第二阶段（005）：最近删除、离线记一条、自动留痕、提醒重试、云端快照 */
export const phase2 = () => has('005');
