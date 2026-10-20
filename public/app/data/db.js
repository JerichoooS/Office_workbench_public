// db.js — 数据库调用的唯一出口：执行查询、统一错误提示、广播数据变化
// 视图层不要直接写 cloud.database；一律通过 data/repos/*.js。

import { toast } from '../core/dom.js';

export const table = name => window.cloud.database.from(name);

const MESSAGES = {
  '42P01': '数据表尚未初始化，请让 WorkBuddy 执行 db/migrations 下的建表脚本',
  '42501': '没有权限执行此操作',
  '23505': '记录已存在',
  '23503': '关联的数据不存在或已删除',
  PGRST301: '登录已过期，请刷新页面',
};

/** 执行查询构造器，返回 data；出错时提示并抛出 */
export async function run(builder) {
  const res = await builder;
  if (res && res.error) {
    const e = res.error;
    const msg = MESSAGES[e.code] || ((e.message || '').includes('JWT') ? MESSAGES.PGRST301 : (e.message || '操作失败'));
    toast(msg);
    const err = new Error(msg); err.code = e.code; err.handled = true;
    throw err;
  }
  return res ? res.data : null;
}

// ---------- 变化通知：仓储写入后调用 changed()，当前视图自动重绘 ----------
const listeners = new Set();
export const onChanged = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export function changed(what) { listeners.forEach(fn => { try { fn(what); } catch (e) { console.error(e); } }); }
