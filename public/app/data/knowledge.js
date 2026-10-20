// knowledge.js — AI 对话的「知识库」：把整个工作台的数据整理成可检索的条目，按问题挑最相关的发给模型
//
// 覆盖：待办（含子步骤、进展记录、等待对象、提醒）、项目（含已归档、联系人）、联系人、材料收集（含已交/未交）。
// 检索（纯本地，不额外调用 AI）：
//   1) 问题与条目文字的中文二字组重合度（「报告」「采购」……）
//   2) 联系人/项目名命中加权；「等/催/回复」「逾期」「今天/本周」「完成」等意图词加权对应状态
//   3) 进行中的条目、近期的条目略加分
// 每次取最相关的约 24 条 + 一段固定的「当前概况」，控制在模型上下文预算内。
// 条目编号：T=待办 P=项目 C=材料收集 K=联系人。模型引用 [T12] 这样的编号，界面渲染成可点的链接。

import { table, run } from './db.js';
import { dayDiff, isOverdue, startOfDay, addDays } from '../core/dates.js';

const fmt = d => { if (!d) return ''; const x = new Date(d); return `${x.getMonth() + 1}/${x.getDate()}${x.getHours() || x.getMinutes() ? ` ${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}` : ''}`; };
const STATUS = { todo: '未开始', doing: '进行中', waiting: '等待他人', done: '已完成' };
const bigrams = s => { const t = String(s || '').replace(/[\s\p{P}]/gu, ''); const out = new Set(); for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2)); if (t.length === 1) out.add(t); return out; };

/** 读取全部数据并建立条目（一次对话打开时调用，之后复用） */
export async function buildIndex() {
  const [todos, tasks, contacts, links, logs, cols, targets, rems] = await Promise.all([
    run(table('todos').select('*')), run(table('tasks').select('*')), run(table('contacts').select('*')),
    run(table('task_contacts').select('task_id,contact_id')), run(table('todo_logs').select('*').order('created_at', { ascending: true })),
    run(table('collections').select('*')), run(table('collection_targets').select('*')),
    run(table('reminders').select('todo_id,kind,fire_at').is('sent_at', null)),
  ]);
  const C = Object.fromEntries(contacts.map(c => [c.id, c])), P = Object.fromEntries(tasks.map(t => [t.id, t]));
  const items = [];

  for (const t of todos) {
    const cl = t.checklist || [], lg = logs.filter(l => String(l.todo_id) === String(t.id)), w = C[t.waiting_on];
    const rm = rems.filter(r => String(r.todo_id) === String(t.id));
    const text = [
      `[T${t.id}] 待办「${t.title}」`, STATUS[t.status], t.priority != null ? `P${t.priority}` : '',
      t.due_at ? `截止 ${fmt(t.due_at)}${isOverdue(t) ? '（已逾期）' : ''}` : '',
      `项目：${P[t.task_id] ? P[t.task_id].title : '零星待办'}`,
      w ? `等待 ${w.name}${w.org ? '（' + w.org + '）' : ''}，自 ${fmt(t.waiting_since)}` : '',
      cl.length ? `子步骤 ${cl.filter(c => c.done).length}/${cl.length}：${cl.map(c => (c.done ? '✓' : '□') + c.text).join('、')}` : '',
      lg.length ? `进展：${lg.slice(-3).map(l => fmt(l.created_at) + ' ' + l.content).join('；')}` : '',
      rm.length ? `待发提醒：${rm.map(r => ({ before_due: '截止前', at_time: '准时', nudge: '催办' }[r.kind]) + ' ' + fmt(r.fire_at)).join('、')}` : '',
      (t.tags || []).length ? `标签：${t.tags.join('、')}` : '', t.notes ? `备注：${t.notes}` : '',
      t.completed_at ? `完成于 ${fmt(t.completed_at)}` : '',
    ].filter(Boolean).join('；');
    items.push({ ref: 'T' + t.id, kind: 'todo', id: t.id, title: t.title, text, open: t.status !== 'done', status: t.status, overdue: isOverdue(t), due: t.due_at, at: t.updated_at, names: [w && w.name, w && w.org, P[t.task_id] && P[t.task_id].title].filter(Boolean) });
  }
  for (const p of tasks) {
    const people = links.filter(l => String(l.task_id) === String(p.id)).map(l => C[l.contact_id]).filter(Boolean);
    const ts = todos.filter(t => String(t.task_id) === String(p.id));
    const text = `[P${p.id}] 项目「${p.title}」${p.archived_at ? '（已归档）' : ''}；${p.start_date || '?'} → ${p.end_date || '?'}；待办 ${ts.filter(t => t.status === 'done').length}/${ts.length} 完成；联系人：${people.map(c => c.name).join('、') || '无'}${p.description ? '；说明：' + p.description : ''}`;
    items.push({ ref: 'P' + p.id, kind: 'task', id: p.id, title: p.title, text, open: !p.archived_at, at: p.updated_at, names: [p.title, ...people.map(c => c.name)] });
  }
  for (const c of cols) {
    const tg = targets.filter(x => String(x.collection_id) === String(c.id)), pend = tg.filter(x => !x.submitted_at);
    const text = `[C${c.id}] 材料收集「${c.title}」${c.closed_at ? '（已结束）' : ''}；截止 ${fmt(c.due_at) || '未设'}；已交 ${tg.length - pend.length}/${tg.length}；未交：${pend.map(x => x.name).join('、') || '无'}；已交：${tg.filter(x => x.submitted_at).map(x => x.name).join('、') || '无'}`;
    items.push({ ref: 'C' + c.id, kind: 'collection', id: c.id, title: c.title, text, open: !c.closed_at, at: c.updated_at, names: tg.map(x => x.name) });
  }
  for (const c of contacts) {
    const n = todos.filter(t => String(t.waiting_on) === String(c.id) && t.status === 'waiting').length;
    items.push({ ref: 'K' + c.id, kind: 'contact', id: c.id, title: c.name, text: `[K${c.id}] 联系人「${c.name}」${c.org ? '，' + c.org : ''}${c.phone ? '，电话 ' + c.phone : ''}${n ? `；正在等 TA 的待办 ${n} 条` : ''}`, open: true, at: c.updated_at, names: [c.name, c.org].filter(Boolean) });
  }
  items.forEach(it => { it.grams = bigrams(it.text); });

  const open = todos.filter(t => t.status !== 'done');
  const monday = addDays(startOfDay(new Date()), -((new Date().getDay() + 6) % 7));
  const summary = `当前概况：未完成待办 ${open.length} 条（逾期 ${open.filter(t => isOverdue(t)).length}，今天到期 ${open.filter(t => t.due_at && dayDiff(new Date(t.due_at)) === 0).length}，等待他人 ${open.filter(t => t.status === 'waiting').length}）；本周完成 ${todos.filter(t => t.completed_at && new Date(t.completed_at) >= monday).length} 条；进行中项目 ${tasks.filter(p => !p.archived_at).length} 个；进行中的材料收集 ${cols.filter(c => !c.closed_at).length} 个。`;
  return { items, summary };
}

const INTENTS = [
  [/等|催|回复|回音|没回/, it => it.status === 'waiting' ? 3 : 0],
  [/逾期|过期|拖/, it => it.overdue ? 4 : 0],
  [/今天|今日/, it => it.due && dayDiff(new Date(it.due)) === 0 ? 3 : 0],
  [/本周|这周|这星期/, it => it.due && Math.abs(dayDiff(new Date(it.due))) <= 7 ? 2 : 0],
  [/完成|做完|搞定/, it => it.status === 'done' ? 2 : 0],
  [/收集|材料|没交|未交|交了/, it => it.kind === 'collection' ? 4 : 0],
  [/项目/, it => it.kind === 'task' ? 2 : 0],
  [/电话|联系|找谁/, it => it.kind === 'contact' ? 3 : 0],
  [/先做|优先|重要|安排|简报|top|Top|TOP/, it => (it.open && it.kind === 'todo' ? 1 : 0) + (it.overdue ? 2 : 0)],
];

/** 为一个问题挑选最相关的条目，返回发给模型的上下文文字 */
export function retrieve(index, question, limit = 24) {
  const q = bigrams(question);
  const scored = index.items.map(it => {
    let s = 0;
    q.forEach(g => { if (it.grams.has(g)) s += 1; });
    if (it.names.some(n => n && question.includes(n))) s += 5;
    if (it.names.some(n => n && n.length >= 2 && [...bigrams(n)].some(g => q.has(g)))) s += 2;
    for (const [re, f] of INTENTS) if (re.test(question)) s += f(it);
    if (it.open) s += 0.5;
    return { it, s };
  }).filter(x => x.s > 0.5).sort((a, b) => b.s - a.s).slice(0, limit);
  // 一个都没命中（泛泛的问题）：给进行中、逾期、临近截止的待办
  const picked = scored.length ? scored.map(x => x.it) : index.items.filter(it => it.kind === 'todo' && it.open).sort((a, b) => (b.overdue - a.overdue) || ((a.due ? new Date(a.due) : 9e15) - (b.due ? new Date(b.due) : 9e15))).slice(0, limit);
  return `${index.summary}\n相关数据（每行开头是编号）：\n${picked.map(it => it.text).join('\n')}`;
}

/** 编号 → 跳转地址 */
export function refHref(ref) {
  const id = ref.slice(1);
  return { T: `#/today?todo=${id}`, P: `#/tasks/${id}`, C: `#/collections?c=${id}`, K: '#/settings/contacts' }[ref[0]];
}
