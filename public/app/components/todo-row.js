// todo-row.js — 待办行（列表）与待办卡片（看板）

import { esc } from '../core/dom.js';
import { dueLabel, isOverdue, dayDiff } from '../core/dates.js';
import { PRIORITY, repeatLabel } from '../data/schema.js';
import { contactById } from '../data/repos/contacts.js';

function metaParts(t, { tasks = {}, hideTask = false } = {}) {
  const out = [];
  const task = t.task_id && tasks[t.task_id];
  if (!hideTask && task) out.push(`<span class="task">${esc(task.title)}</span>`);
  if (t.status === 'waiting') {
    const w = contactById(t.waiting_on);
    const days = t.waiting_since ? Math.max(0, -dayDiff(new Date(t.waiting_since))) : 0;
    out.push(`<span class="chip wait">等 ${esc(w ? w.name : '他人')} · ${days} 天</span>`);
  }
  if (t.status === 'doing') out.push('<span class="chip accent">进行中</span>');
  const cl = t.checklist || [];
  if (cl.length) {
    const n = cl.filter(c => c.done).length;
    out.push(`<span class="num">${n}/${cl.length}</span><span class="mini-bar"><i style="width:${(n / cl.length) * 100}%"></i></span>`);
  }
  if (t.repeat_rule) out.push(`<span>↻ ${esc(repeatLabel(t.repeat_rule))}</span>`);
  return out;
}

export function todoRow(t, ctx = {}) {
  const done = t.status === 'done';
  const pr = PRIORITY.find(p => p.v === t.priority);
  const meta = metaParts(t, ctx);
  if (ctx.move && !t.task_id && t.status !== 'done') meta.push(`<button class="chip ghost" data-move="${t.id}">归入项目 ›</button>`);
  const over = isOverdue(t);
  return `<div class="item ${done ? 'done' : ''} ${ctx.sel == t.id ? 'sel' : ''}" data-todo="${t.id}">
    <button class="check ${pr ? pr.cls : ''}" data-check="${t.id}" aria-label="${done ? '标记为未完成' : '标记完成'}"></button>
    <div style="min-width:0"><div class="t-title">${esc(t.title)}</div>${meta.length ? `<div class="t-meta">${meta.join('')}</div>` : ''}</div>
    <div class="t-side ${over ? 'bad' : ''}">${esc(dueLabel(t.due_at, t.due_all_day))}</div></div>`;
}

export function todoCard(t, ctx = {}) {
  const task = t.task_id && ctx.tasks && ctx.tasks[t.task_id];
  const w = t.status === 'waiting' ? contactById(t.waiting_on) : null;
  const cl = t.checklist || [];
  const n = cl.filter(c => c.done).length;
  const over = isOverdue(t);
  const pr = PRIORITY.find(p => p.v === t.priority);
  return `<button class="card" data-todo="${t.id}">
    <div class="t-title">${pr && pr.v <= 1 ? `<span class="chip ${pr.chip}" style="padding:0 6px;margin-right:4px">${pr.label}</span>` : ''}${esc(t.title)}</div>
    <div class="t-meta"><span class="task">${task ? esc(task.title) : '零星待办'}</span>${t.due_at ? `<span class="due ${over ? 'bad' : ''}">${esc(dueLabel(t.due_at, t.due_all_day))}</span>` : ''}</div>
    ${w || cl.length ? `<div class="t-meta">${w ? `<span class="chip wait">等 ${esc(w.name)}</span>` : ''}${cl.length ? `<span class="num">${n}/${cl.length}</span><span class="mini-bar"><i style="width:${(n / cl.length) * 100}%"></i></span>` : ''}</div>` : ''}
  </button>`;
}

export const byId = rows => Object.fromEntries((rows || []).map(r => [r.id, r]));
