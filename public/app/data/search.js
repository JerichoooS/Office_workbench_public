// search.js — 待办搜索（全部待办页、概览、侧边栏 Ctrl/⌘K）
// 规则：不分大小写、忽略空格（「A区3楼」能搜到「A 区 3 楼」）；多个词用空格隔开 = 都要包含。
// 搜索范围：标题、备注、标签、子步骤、进展记录、等待对象（名称和单位）、项目名和项目说明。
// 命中的不是标题时，行里显示命中的那一小段（t.snippet，已转义并高亮）。

import { esc } from '../core/dom.js';
import { table, runAll } from './db.js';
import { contactById } from './repos/contacts.js';
import { phase2 } from './features.js';

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, '');

/** 读进展记录（只在有搜索词时调用）：{ todo_id: [内容…] }。只搜手写的：自动留痕（完成、改截止、已催）每条都差不多，搜了全是噪音 */
export async function logsByTodo() {
  const rows = await runAll(() => table('todo_logs').select(phase2() ? 'todo_id,content,kind' : 'todo_id,content').order('id', { ascending: true }));
  const out = {};
  rows.forEach(r => { if (!r.kind || r.kind === 'note') (out[r.todo_id] = out[r.todo_id] || []).push(r.content); });
  return out;
}

/**
 * 过滤待办。返回命中的待办（浅拷贝，命中位置在 snippet）。
 * tasks: { id: 项目 }；logs: logsByTodo() 的结果（可省略）
 */
export function searchTodos(todos, q, { tasks = {}, logs = {} } = {}) {
  const terms = String(q || '').trim().split(/\s+/).map(norm).filter(Boolean);
  if (!terms.length) return todos;
  const whole = terms.join('');
  return todos.flatMap(t => {
    const w = contactById(t.waiting_on), task = tasks[t.task_id];
    const fields = [
      ['', t.title], ['备注', t.notes], ['标签', (t.tags || []).join(' ')],
      ['子步骤', (t.checklist || []).map(c => c.text).join('；')], ['进展', (logs[t.id] || []).join('；')],
      ['等待', w && [w.name, w.org].filter(Boolean).join(' ')], ['项目', task && task.title], ['项目说明', task && task.description],
    ].filter(f => f[1]);
    const hay = norm(fields.map(f => f[1]).join('\n'));
    if (!terms.every(x => hay.includes(x)) && !hay.includes(whole)) return [];
    if (terms.some(x => norm(t.title).includes(x))) return [t];
    const f = fields.find(f => terms.some(x => norm(f[1]).includes(x)));
    return [{ ...t, snippet: f ? `${f[0]}：${excerpt(f[1], terms)}` : '' }];
  });
}

/** 命中处前后各取一些字，命中的词加 <mark> */
function excerpt(text, terms) {
  const s = String(text).replace(/\s+/g, ' ');
  const low = s.toLowerCase();
  let at = -1;
  for (const x of terms) { const i = low.indexOf(x); if (i >= 0 && (at < 0 || i < at)) at = i; }
  const from = Math.max(0, at - 12), part = s.slice(from, from + 40);
  let html = esc(part);
  terms.forEach(x => { const re = new RegExp(esc(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'); html = html.replace(re, m => `<mark>${m}</mark>`); });
  return (from > 0 ? '…' : '') + html + (from + 40 < s.length ? '…' : '');
}
