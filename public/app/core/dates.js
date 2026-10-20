// dates.js — 日期工具（统一按用户本地时区显示；数据库存 ISO 时间 / YYYY-MM-DD 日期）

export const WD = ['日', '一', '二', '三', '四', '五', '六'];
const pad = n => String(n).padStart(2, '0');

export function startOfDay(d = new Date()) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
export function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
export function dayDiff(a, b = new Date()) { return Math.round((startOfDay(a) - startOfDay(b)) / 86400000); }
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const md = d => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 把 'YYYY-MM-DD' 解析为本地日期（避免 new Date('2026-10-20') 被当成 UTC） */
export function parseYmd(s) { if (!s) return null; const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }

/** 截止时间的人话显示：今天 17:00 / 明天 / 昨天 18:00 / 10-24 周五 */
export function dueLabel(dueAt, allDay) {
  if (!dueAt) return '';
  const d = new Date(dueAt), diff = dayDiff(d);
  const word = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === -1 ? '昨天' : diff === 2 ? '后天'
    : (diff > 0 && diff < 7) ? `周${WD[d.getDay()]}` : `${md(d)} 周${WD[d.getDay()]}`;
  return allDay ? word : `${word} ${hm(d)}`;
}

/** 是否逾期：有时刻的按时刻，全天的按当天结束 */
export function isOverdue(todo, now = new Date()) {
  if (!todo.due_at || todo.status === 'done') return false;
  const d = new Date(todo.due_at);
  return todo.due_all_day ? dayDiff(d, now) < 0 : d < now;
}

/** 「今天」的标题：10月20日 周二 */
export function todayTitle(d = new Date()) { return `${d.getMonth() + 1}月${d.getDate()}日 周${WD[d.getDay()]}`; }

/** 相对时间（用于进展记录）：刚刚 / 3 小时前 / 10-18 16:05 */
export function ago(iso) {
  const d = new Date(iso), s = (Date.now() - d) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (dayDiff(d) === 0) return `今天 ${hm(d)}`;
  if (dayDiff(d) === -1) return `昨天 ${hm(d)}`;
  return `${md(d)} ${hm(d)}`;
}
