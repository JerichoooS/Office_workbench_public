// schema.js — 枚举值与中文显示名（库里存英文值，界面只用这里的中文）
// 改动枚举时：同时改 db/migrations 里对应的 CHECK 约束，并在 docs/开发规范.md 的数据表一节登记。

export const TODO_STATUS = [
  { v: 'todo', label: '未开始', color: 'var(--ink-3)', chip: '' },
  { v: 'doing', label: '进行中', color: 'var(--accent)', chip: 'accent' },
  { v: 'waiting', label: '等待他人', color: 'var(--wait)', chip: 'wait' },
  { v: 'done', label: '已完成', color: 'var(--ok)', chip: 'ok' },
];
export const todoStatus = v => TODO_STATUS.find(s => s.v === v) || TODO_STATUS[0];

export const TASK_STATUS = [
  { v: 'not_started', label: '未开始' },
  { v: 'in_progress', label: '进行中' },
  { v: 'done', label: '已完成' },
];
export const taskStatus = v => TASK_STATUS.find(s => s.v === v) || TASK_STATUS[1];

export const CONTACT_KIND = [
  { v: 'person', label: '人' },
  { v: 'department', label: '部门' },
  { v: 'section', label: '科室' },
  { v: 'unit', label: '单位' },
];
export const contactKind = v => (CONTACT_KIND.find(k => k.v === v) || CONTACT_KIND[0]).label;

export const PRIORITY = [
  { v: 0, label: 'P0', chip: 'bad', cls: 'p0' },
  { v: 1, label: 'P1', chip: 'warn', cls: 'p1' },
  { v: 2, label: 'P2', chip: 'accent', cls: '' },
  { v: 3, label: 'P3', chip: '', cls: '' },
];

export const DEFAULT_REMINDER = [
  { v: 'none', label: '不提醒', minutes: null },
  { v: 'before_15', label: '截止前 15 分钟', minutes: 15 },
  { v: 'before_60', label: '截止前 1 小时', minutes: 60 },
  { v: 'before_1440', label: '截止前 1 天', minutes: 1440 },
];

/** 重复规则的中文描述：{freq:'weekly',days:[1,3]} → 每周一、三 */
export function repeatLabel(r) {
  if (!r) return '不重复';
  const WD = ['日', '一', '二', '三', '四', '五', '六'];
  if (r.freq === 'daily') return '每天';
  if (r.freq === 'weekdays') return '每个工作日';
  if (r.freq === 'weekly') return '每周' + (r.days || []).map(d => WD[d]).join('、');
  if (r.freq === 'monthly') return `每月 ${r.day} 号`;
  return '自定义';
}
