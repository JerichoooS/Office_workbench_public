// export.js — 一键导出（设置 › 数据与备份）
// 三种格式：
//   JSON      完整备份：所有表原样导出，以后可以导回（不含 AI Key、推送订阅这类设备/密钥信息）
//   Markdown  给人看的：按项目列出待办、子步骤、备注和进展；用任何文本编辑器、Word、WPS 都能打开
//   CSV       待办清单一张表，Excel / WPS 表格直接打开（带 BOM，中文不乱码）
// 手机上导出走系统「分享」（可存到「文件」、发到微信电脑版）；电脑上直接下载。

import { table, runAll } from './db.js';
import { ymd, hm, parseYmd } from '../core/dates.js';
import { todoStatus, taskStatus, contactKind, repeatLabel, PRIORITY } from './schema.js';

// 备份的表（push_subscriptions 是设备推送凭据、server_config 是服务器口令，不导出）
const TABLES = ['user_settings', 'contacts', 'tasks', 'task_contacts', 'todos', 'todo_logs', 'reminders', 'collections', 'collection_targets', 'tags'];
const ORDER = { user_settings: 'owner_id', default: 'id' };

/** 读出全部数据（分页读完，平台限制单次行数也不会漏） */
export async function loadAll() {
  const out = {};
  for (const t of TABLES) {
    const key = ORDER[t] || ORDER.default;
    out[t] = await runAll(() => table(t).select('*').order(key, { ascending: true }));
  }
  out.user_settings = out.user_settings.map(({ llm_api_key, ...rest }) => ({ ...rest, llm_api_key: llm_api_key ? '（已省略）' : null }));
  return out;
}

const stamp = (d = new Date()) => ymd(d);
const fmtTime = iso => { if (!iso) return ''; const d = new Date(iso); return `${ymd(d)} ${hm(d)}`; };
const fmtDue = t => !t.due_at ? '' : t.due_all_day ? ymd(new Date(t.due_at)) : fmtTime(t.due_at);
const fmtDate = s => s ? ymd(parseYmd(s)) : '';

// ---------- 三种格式 ----------
/** extra：附加的说明字段（云端快照：{ source: 'snapshot', day }） */
export function toJSON(data, extra = {}) {
  return JSON.stringify({ app: '个人工作台', format: 1, exported_at: new Date().toISOString(), ...extra, tables: data }, null, 2);
}

export function toMarkdown(data) {
  const contacts = new Map(data.contacts.map(c => [c.id, c]));
  const logsBy = groupBy(data.todo_logs, 'todo_id');
  const todosBy = groupBy(data.todos, 'task_id');
  const name = id => (contacts.get(id) || {}).name || '';
  const L = [`# 工作台导出 · ${stamp()}`, '', `项目 ${data.tasks.length} 个 · 待办 ${data.todos.length} 条 · 进展 ${data.todo_logs.length} 条 · 联系人 ${data.contacts.length} 个`, ''];

  const todoBlock = t => {
    const st = todoStatus(t.status).label;
    const meta = [st, fmtDue(t) && `截止 ${fmtDue(t)}`, t.priority != null && PRIORITY[t.priority] && PRIORITY[t.priority].label,
      t.status === 'waiting' && t.waiting_on && `等 ${name(t.waiting_on)}`, t.repeat_rule && repeatLabel(t.repeat_rule),
      (t.tags || []).length && (t.tags || []).map(x => '#' + x).join(' '), t.completed_at && `完成于 ${fmtTime(t.completed_at)}`].filter(Boolean).join(' · ');
    const out = [`- [${t.status === 'done' ? 'x' : ' '}] **${oneLine(t.title)}**　${meta}`];
    (t.checklist || []).forEach(c => out.push(`    - [${c.done ? 'x' : ' '}] ${oneLine(c.text)}`));
    if (t.notes) out.push(...indent('备注：' + t.notes));
    (logsBy.get(t.id) || []).forEach(l => out.push(`    - ${fmtTime(l.created_at)}　${oneLine(l.content)}`));
    return out;
  };

  const sortTodos = list => [...list].sort((a, b) => (a.status === 'done') - (b.status === 'done') || String(a.due_at || '9').localeCompare(String(b.due_at || '9')));
  const tasks = [...data.tasks].sort((a, b) => (!!a.archived_at - !!b.archived_at) || String(b.start_date || '').localeCompare(String(a.start_date || '')));
  tasks.forEach(k => {
    L.push(`## ${oneLine(k.title)}${k.archived_at ? '（已归档）' : ''}`, '');
    L.push([taskStatus(k.status).label, (k.start_date || k.end_date) && `${fmtDate(k.start_date) || '?'} 至 ${fmtDate(k.end_date) || '?'}`, (k.tags || []).length && k.tags.map(x => '#' + x).join(' ')].filter(Boolean).join(' · '), '');
    if (k.description) L.push(k.description, '');
    const people = data.task_contacts.filter(x => x.task_id === k.id).map(x => name(x.contact_id)).filter(Boolean);
    if (people.length) L.push('相关：' + people.join('、'), '');
    const list = sortTodos(todosBy.get(k.id) || []);
    if (list.length) { list.forEach(t => L.push(...todoBlock(t))); L.push(''); }
  });
  const loose = sortTodos(todosBy.get(null) || []);
  if (loose.length) { L.push('## 零星待办', ''); loose.forEach(t => L.push(...todoBlock(t))); L.push(''); }

  if (data.collections.length) {
    L.push('## 材料收集', '');
    const targets = groupBy(data.collection_targets, 'collection_id');
    data.collections.forEach(c => {
      const ts = targets.get(c.id) || [];
      L.push(`### ${oneLine(c.title)}${c.closed_at ? '（已结束）' : ''}`, '', `截止 ${fmtTime(c.due_at) || '未定'} · 已交 ${ts.filter(x => x.submitted_at).length}/${ts.length}`, '');
      ts.forEach(x => L.push(`- [${x.submitted_at ? 'x' : ' '}] ${oneLine(x.name)}${x.submitted_at ? `　${fmtTime(x.submitted_at)}` : ''}${x.note ? `　${oneLine(x.note)}` : ''}`));
      L.push('');
    });
  }
  if (data.contacts.length) {
    L.push('## 联系人', '', '| 名称 | 类型 | 单位/部门 | 电话 | 备注 |', '|---|---|---|---|---|');
    data.contacts.forEach(c => L.push(`| ${cell(c.name)} | ${contactKind(c.kind)} | ${cell(c.org)} | ${cell(c.phone)} | ${cell(c.note)} |`));
    L.push('');
  }
  return L.join('\n');
}

export function toCSV(data) {
  const tasks = new Map(data.tasks.map(t => [t.id, t]));
  const contacts = new Map(data.contacts.map(c => [c.id, c]));
  const logsBy = groupBy(data.todo_logs, 'todo_id');
  const head = ['项目', '待办', '状态', '优先级', '截止', '等待对象', '开始等待', '重复', '标签', '子步骤', '备注', '进展记录', '完成时间', '创建时间'];
  const rows = data.todos.map(t => {
    const logs = (logsBy.get(t.id) || []).map(l => `${fmtTime(l.created_at)} ${l.content}`).join('\n');
    return [(tasks.get(t.task_id) || {}).title || '（零星待办）', t.title, todoStatus(t.status).label, t.priority != null && PRIORITY[t.priority] ? PRIORITY[t.priority].label : '',
      fmtDue(t), (contacts.get(t.waiting_on) || {}).name || '', fmtTime(t.waiting_since), t.repeat_rule ? repeatLabel(t.repeat_rule) : '', (t.tags || []).join(' '),
      (t.checklist || []).map(c => `${c.done ? '☑' : '☐'} ${c.text}`).join('\n'), t.notes || '', logs, fmtTime(t.completed_at), fmtTime(t.created_at)];
  });
  return '﻿' + [head, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
}

// 文件名用英文：部分浏览器（实测无界面 Chromium）遇到中文文件名会存成没有扩展名的「download」，打不开
export const FORMATS = {
  json: { label: '完整备份（JSON）', desc: '所有数据原样导出，以后能导回', ext: 'json', mime: 'application/json', name: 'workbench-backup', make: toJSON },
  md: { label: '阅读版（Markdown）', desc: '按项目整理的文字版，记事本就能打开', ext: 'md', mime: 'text/markdown', name: 'workbench', make: toMarkdown },
  csv: { label: '待办表格（CSV）', desc: 'Excel / WPS 表格直接打开，一行一条待办', ext: 'csv', mime: 'text/csv', name: 'workbench-todos', make: toCSV },
};

/** 生成文件（不触发保存）；返回 File */
export async function buildExport(kind) {
  const f = FORMATS[kind];
  const text = f.make(await loadAll());
  return new File([text], `${f.name}-${stamp()}.${f.ext}`, { type: f.mime + ';charset=utf-8' });
}

/** 云端快照（含 data）→ 与完整备份同样格式的 JSON 文件，可以直接用来「从备份找回」 */
export function snapshotFile(snap) {
  return new File([toJSON(snap.data || {}, { source: 'snapshot', day: snap.day })], `workbench-snapshot-${snap.day}.json`, { type: 'application/json;charset=utf-8' });
}

/** 文件大小的人话：860 B / 12 KB / 1.3 MB */
export const sizeLabel = n => (n < 1024 ? n + ' B' : n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB');

/** 保存文件：手机走系统分享，电脑直接下载。必须在用户点按的处理函数里同步调用（iOS 要求） */
export async function saveFile(file) {
  const touch = window.matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: file.name }); return 'shared'; }
    catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; /* 不允许分享就退回下载 */ }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = file.name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return 'downloaded';
}

// ---------- 小工具 ----------
function groupBy(list, key) { const m = new Map(); list.forEach(x => { const k = x[key] ?? null; if (!m.has(k)) m.set(k, []); m.get(k).push(x); }); return m; }
const oneLine = s => String(s || '').replace(/\s*\n\s*/g, ' ').trim();
const indent = s => String(s).split('\n').map(l => '    ' + l);
const cell = s => oneLine(s).replace(/\|/g, '｜');
// 以 = + - @ 开头的格子在 Excel 里会被当成公式，前面加个单引号
const csvCell = v => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
