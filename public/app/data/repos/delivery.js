// delivery.js — 提醒送达情况（首页提示卡 components/notices/delivery.js 用）
//   没送达：服务器重试 3 次仍失败的（reminders.failed_at，第二阶段才有这一列）
//   没发出：过了时间很久还没发（sent_at 为空）——服务器的提醒服务可能没在运行
// 只读；带上待办标题，已完成的待办不算。

import { table, run } from '../db.js';
import { phase2 } from '../features.js';

async function withTitles(rems) {
  if (!rems.length) return [];
  const ids = [...new Set(rems.map(r => r.todo_id))];
  const todos = await run(table('todos').select('id,title,status').in('id', ids));
  const T = new Map(todos.map(t => [String(t.id), t]));
  return rems.map(r => ({ ...r, todo: T.get(String(r.todo_id)) })).filter(r => r.todo && r.todo.status !== 'done');
}

/** 最近 days 天里没送达的提醒（新的在前）；旧库返回 [] */
export async function failedReminders(days = 3) {
  if (!phase2()) return [];
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return withTitles(await run(table('reminders').select('id,todo_id,kind,fire_at,failed_at').gte('failed_at', since).order('failed_at', { ascending: false }).limit(50)));
}

/** 过了时间超过 minutes 分钟还没发出的提醒（正在重试的按重试时间算） */
export async function staleReminders(minutes = 10) {
  const cut = new Date(Date.now() - minutes * 60000).toISOString();
  const cols = phase2() ? 'id,todo_id,kind,fire_at,retry_at,failed_at' : 'id,todo_id,kind,fire_at';
  const rows = await run(table('reminders').select(cols).is('sent_at', null).lt('fire_at', cut).order('fire_at', { ascending: false }).limit(50));
  return withTitles(rows.filter(r => !r.failed_at && (!r.retry_at || r.retry_at < cut)));
}
