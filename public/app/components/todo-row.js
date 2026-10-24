// todo-row.js — 待办行（列表）与待办卡片（看板），以及所有列表共用的「勾选完成」
// 列表行统一规则（2026-10-22 全面优化）：
//   - 勾选圈的可点范围 44×44（手指不会点歪到整行打开详情）
//   - 标题最多两行；项目名、等待对象、子步骤进度、重复在第二行
//   - 等待他人的待办显示「等 X · N 天 · 下次催 周五」（ctx.nudges 传入 todo_id → 下次催办时间）
//   - 所属项目已归档时显示「（已归档）」
//   - 勾选完成：同一条在保存完成前不会重复触发；完成后 5 秒内可「撤销」（连同自动生成的下一次、「完成」留痕一起撤回）
//   - 补交逾期的重复待办：今天这期照常保留，提示「完成 ✓ 已生成下一次（跳过了 N 期）」

import { esc, toast } from '../core/dom.js';
import { dueLabel, isOverdue, dayDiff, WD } from '../core/dates.js';
import { PRIORITY, repeatLabel } from '../data/schema.js';
import { contactById } from '../data/repos/contacts.js';
import { setStatus, undoDone } from '../data/repos/todos.js';
import { table, run, saveFailed } from '../data/db.js';

const nudgeLabel = iso => {
  if (!iso) return '';
  const d = new Date(iso), n = dayDiff(d);
  return n <= 0 ? '今天催' : n === 1 ? '明天催' : n < 7 ? `周${WD[d.getDay()]}催` : `${d.getMonth() + 1}/${d.getDate()} 催`;
};

function metaParts(t, { tasks = {}, hideTask = false, nudges = null } = {}) {
  const out = [];
  const task = t.task_id && tasks[t.task_id];
  if (!hideTask && task) out.push(`<span class="task">${esc(task.title)}${task.archived_at ? '（已归档）' : ''}</span>`);
  if (t.status === 'waiting') {
    const w = contactById(t.waiting_on);
    const days = t.waiting_since ? Math.max(0, -dayDiff(new Date(t.waiting_since))) : 0;
    const next = nudges && nudges[t.id] ? ` · ${nudgeLabel(nudges[t.id])}` : '';
    out.push(`<span class="chip wait">等 ${esc(w ? w.name : '他人')} · ${days} 天${next}</span>`);
  }
  if (t.status === 'doing') out.push('<span class="chip accent">进行中</span>');
  const cl = t.checklist || [];
  if (cl.length) {
    const n = cl.filter(c => c.done).length;
    out.push(`<span class="num">${n}/${cl.length}</span><span class="mini-bar"><i style="width:${(n / cl.length) * 100}%"></i></span>`);
  }
  if (t.repeat_rule) out.push(`<span>↻ ${esc(repeatLabel(t.repeat_rule))}</span>`);
  if (t.snippet) out.push(`<span class="snip">${t.snippet}</span>`);   // 搜索命中的位置（search.js 已转义并高亮）
  return out;
}

export function todoRow(t, ctx = {}) {
  const done = t.status === 'done';
  const pr = PRIORITY.find(p => p.v === t.priority);
  const meta = metaParts(t, ctx);
  if (ctx.move && !t.task_id && t.status !== 'done') meta.push(`<button class="chip ghost" data-move="${t.id}">归入项目 ›</button>`);
  const over = isOverdue(t);
  return `<div class="item ${done ? 'done' : ''} ${ctx.sel == t.id ? 'sel' : ''}" data-todo="${t.id}">
    <button class="check ${pr ? pr.cls : ''}" data-check="${t.id}" aria-label="${done ? '标记为未完成' : '标记完成'}：${esc(t.title)}"><i class="ring"></i></button>
    <div style="min-width:0"><div class="t-title clamp">${esc(t.title)}</div>${meta.length ? `<div class="t-meta">${meta.join('')}</div>` : ''}</div>
    <div class="t-side ${over ? 'bad' : ''}">${esc(dueLabel(t.due_at, t.due_all_day))}</div></div>`;
}

export function todoCard(t, ctx = {}) {
  const task = t.task_id && ctx.tasks && ctx.tasks[t.task_id];
  const w = t.status === 'waiting' ? contactById(t.waiting_on) : null;
  const days = w && t.waiting_since ? Math.max(0, -dayDiff(new Date(t.waiting_since))) : null;
  const cl = t.checklist || [];
  const n = cl.filter(c => c.done).length;
  const over = isOverdue(t);
  const pr = PRIORITY.find(p => p.v === t.priority);
  return `<button class="card" data-todo="${t.id}">
    <div class="t-title clamp">${pr && pr.v <= 1 ? `<span class="chip ${pr.chip}" style="padding:0 6px;margin-right:4px">${pr.label}</span>` : ''}${esc(t.title)}</div>
    <div class="t-meta"><span class="task">${task ? esc(task.title) : '零星待办'}</span>${t.due_at ? `<span class="due ${over ? 'bad' : ''}">${esc(dueLabel(t.due_at, t.due_all_day))}</span>` : ''}</div>
    ${w || cl.length ? `<div class="t-meta">${w ? `<span class="chip wait">等 ${esc(w.name)}${days != null ? ` · ${days} 天` : ''}</span>` : ''}${cl.length ? `<span class="num">${n}/${cl.length}</span><span class="mini-bar"><i style="width:${(n / cl.length) * 100}%"></i></span>` : ''}</div>` : ''}
  </button>`;
}

export const byId = rows => Object.fromEntries((rows || []).map(r => [r.id, r]));

/** 待发送的催办：{ todo_id: 下次催办时间 }（列表行显示「下次催」用） */
export async function pendingNudges() {
  const rows = await run(table('reminders').select('todo_id,fire_at').eq('kind', 'nudge').is('sent_at', null).order('fire_at', { ascending: true }));
  const out = {};
  rows.forEach(r => { if (!out[r.todo_id]) out[r.todo_id] = r.fire_at; });
  return out;
}

// ---------- 勾选完成（所有列表共用） ----------
const busy = new Set();

/** 切换完成 / 未完成。el = 被点的勾选按钮（用于动画）；task = 所属项目（催办节奏用） */
export async function toggleDone(t, { task = null, el = null } = {}) {
  if (!t || busy.has(t.id)) return;
  busy.add(t.id);
  const row = el && el.closest('.item');
  const wasDone = t.status === 'done';
  if (row) row.classList.add(wasDone ? 'undoing' : 'completing');
  try {
    const r = await setStatus(t, wasDone ? 'todo' : 'done', { task });
    if (wasDone) toast('已恢复为未完成');
    else toast(doneText(r), { action: { label: '撤销', onClick: () => undo(t, r, task) } });
  } catch (e) {
    if (row) row.classList.remove('completing', 'undoing');
    saveFailed(e);
  } finally {
    busy.delete(t.id);
  }
}

/** 完成后的提示：生成了下一次就说一声，补交逾期跳过了几期也说 */
const doneText = r => (r && r.next ? `完成 ✓ 已生成下一次${r.skipped ? `（跳过了 ${r.skipped} 期）` : ''}` : '完成 ✓');

/** 撤销完成：恢复原来的状态；删掉「完成」留痕和自动生成的下一次（不进最近删除）；重新排催办（todos.undoDone） */
async function undo(t, r, task) {
  try { await undoDone(t, r, { task }); toast('已撤销'); } catch (e) { saveFailed(e); }
}
