// report.js — 周报草稿（通用格式；用户确认没有往期周报可参照，2026-10-22）
// 五段：一、本周完成 二、推进中 三、需协调 四、下周计划 五、材料收集；每段内按项目分组。
// 只用工作台里已有的「进展」信息：待办标题、完成时间、等待对象、最近一条进展；不编造内容。
// 第二阶段的自动留痕：推进中 / 需协调后面附的仍是本周最后一条「手写」进展（自动的「改截止」「转为进行中」不算推进）；
//   需协调里加「已催 N 次」（这一轮等待开始后点过几次「已催」，没执行 005 时没有这项）。
// 只读没完成的 + 那一周以来完成的待办（不再读全部已完成的）。
// 生成的是草稿：在弹层里可以直接改，再复制到微信 / 公文里。

import { table, run } from './db.js';
import { phase2 } from './features.js';
import { listTodos } from './repos/todos.js';
import { startOfDay, addDays, dayDiff, WD } from '../core/dates.js';

/** 周一 00:00；offset=-1 为上周 */
export function weekStart(offset = 0, now = new Date()) {
  const d = startOfDay(now);
  return addDays(d, -((d.getDay() + 6) % 7) + offset * 7);
}

const dayLabel = d => `${d.getMonth() + 1}月${d.getDate()}日`;
const short = (s, n = 40) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

export async function weeklyReport(offset = 0) {
  const from = weekStart(offset), to = addDays(from, 7), nextTo = addDays(to, 7);
  const [todos, logs, tasks, contacts, cols] = await Promise.all([
    listTodos({ done: { since: from } }).then(rows => rows.sort((a, b) => Number(a.id) - Number(b.id))),
    run(table('todo_logs').select('*').gte('created_at', from.toISOString()).lt('created_at', to.toISOString()).order('created_at', { ascending: true })),
    run(table('tasks').select('id,title,archived_at,end_date').order('id', { ascending: true })),
    run(table('contacts').select('id,name')),
    run(table('collections').select('*').is('closed_at', null).order('due_at', { ascending: true, nullsFirst: false })),
  ]);
  const targets = cols.length ? await run(table('collection_targets').select('*').in('collection_id', cols.map(c => c.id))) : [];
  const taskName = new Map(tasks.map(t => [t.id, t.title]));
  const who = new Map(contacts.map(c => [c.id, c.name]));
  const lastLog = new Map(); logs.forEach(l => { if (!l.kind || l.kind === 'note') lastLog.set(l.todo_id, l); });   // 只认手写的
  const inWeek = iso => iso && new Date(iso) >= from && new Date(iso) < to;

  const done = todos.filter(t => t.status === 'done' && inWeek(t.completed_at));
  const waiting = todos.filter(t => t.status === 'waiting');
  const doing = todos.filter(t => t.status !== 'done' && t.status !== 'waiting' && (t.status === 'doing' || lastLog.has(t.id)));
  const listed = new Set([...waiting, ...doing].map(t => t.id));
  // 已催几次：这一轮等待开始之后的「已催」留痕
  const nudgedLogs = phase2() && waiting.length ? await run(table('todo_logs').select('todo_id,created_at').eq('kind', 'nudged').in('todo_id', waiting.map(t => t.id))) : [];
  const nudgedTimes = t => nudgedLogs.filter(l => String(l.todo_id) === String(t.id) && (!t.waiting_since || new Date(l.created_at) >= new Date(t.waiting_since))).length;
  // 下周计划：下周结束前到期、还没完成的（含已逾期），已在「推进中」「需协调」里的不重复列
  const plan = todos.filter(t => t.status !== 'done' && t.due_at && new Date(t.due_at) < nextTo && !listed.has(t.id))
    .sort((a, b) => new Date(a.due_at) - new Date(b.due_at));

  const due = t => {
    if (!t.due_at) return '';
    const d = new Date(t.due_at), late = t.due_all_day ? dayDiff(d) < 0 : d < new Date();
    return late ? '（已逾期）' : `（${dayLabel(d)} 周${WD[d.getDay()]}）`;
  };
  const sections = [
    ['本周完成', done, t => t.title],
    ['推进中', doing, t => t.title + (lastLog.has(t.id) ? `：${short(lastLog.get(t.id).content)}` : '')],
    ['需协调', waiting, t => {
      const days = t.waiting_since ? Math.max(0, -dayDiff(new Date(t.waiting_since))) : null;
      const n = nudgedTimes(t);
      const w = [who.get(t.waiting_on) && `等${who.get(t.waiting_on)}`, days != null && `已 ${days} 天`, n > 0 && `已催 ${n} 次`].filter(Boolean).join('，');
      return t.title + (w ? `（${w}）` : '') + (lastLog.has(t.id) ? `：${short(lastLog.get(t.id).content)}` : '');
    }],
    ['下周计划', plan, t => t.title + due(t)],
  ];

  const NUM = ['一', '二', '三', '四', '五', '六'];
  const out = [`周报（${dayLabel(from)}—${dayLabel(addDays(to, -1))}）`, ''];
  let n = 0;
  sections.forEach(([title, list, line]) => {
    out.push(`${NUM[n++]}、${title}`);
    if (!list.length) { out.push('无', ''); return; }
    // 按项目分组：有项目的在前（按项目 id），零星待办最后
    const groups = new Map();
    list.forEach(t => { const k = t.task_id || 0; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); });
    const keys = [...groups.keys()].sort((a, b) => (a === 0) - (b === 0) || a - b);
    let i = 0;
    keys.forEach(k => {
      if (keys.length > 1 || k !== 0) out.push(`【${k ? taskName.get(k) || '项目' : '其他'}】`);
      groups.get(k).forEach(t => out.push(`${++i}. ${line(t)}`));
    });
    out.push('');
  });
  out.push(`${NUM[n++]}、材料收集`);
  if (!cols.length) out.push('无');
  cols.forEach((c, i) => {
    const ts = targets.filter(x => String(x.collection_id) === String(c.id));
    const left = ts.filter(x => !x.submitted_at).map(x => x.name);
    out.push(`${i + 1}. ${c.title}：已交 ${ts.length - left.length}/${ts.length}` + (left.length ? `，未交：${left.join('、')}` : '，已收齐'));
  });
  return { text: out.join('\n').trim() + '\n', from, to, counts: { done: done.length, doing: doing.length, waiting: waiting.length, plan: plan.length } };
}
