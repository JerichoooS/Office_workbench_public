// notify.js — 通知文案（纯函数，前端预览与 server.js 共用；server 通过 import() 加载）
// 时间一律按用户时区（user_settings.timezone，默认 Asia/Shanghai）显示，服务器在哪个时区都不影响。
// 点击通知打开的地址：
//   单条待办 → /#/today?todo=<id>（打开后直接弹出详情）
//   早报     → /#/today
//   晚报     → /#/today?review=1（展开「今天完成」）

const WD = ['日', '一', '二', '三', '四', '五', '六'];

/** 某时刻在指定时区的「年月日时分星期」 */
export function zoned(date, tz = 'Asia/Shanghai') {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(new Date(date)).map(x => [x.type, x.value]));
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, wd, key: `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}` };
}

const dayIndex = z => Date.UTC(z.y, z.m - 1, z.d) / 86400000;

/** 截止时间的人话（按时区）：今天 17:00 / 明天 / 10/24 周五 */
export function dueText(dueAt, allDay, now = new Date(), tz) {
  if (!dueAt) return '';
  const z = zoned(dueAt, tz), n = zoned(now, tz), diff = dayIndex(z) - dayIndex(n);
  const w = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === -1 ? '昨天' : `${z.m}/${z.d} 周${WD[z.wd]}`;
  return allDay ? w : `${w} ${String(z.h).padStart(2, '0')}:${String(z.min).padStart(2, '0')}`;
}

function isOverdue(t, now, tz) {
  if (!t.due_at || t.status === 'done') return false;
  return t.due_all_day ? dayIndex(zoned(t.due_at, tz)) < dayIndex(zoned(now, tz)) : new Date(t.due_at) < now;
}
const isDueToday = (t, now, tz) => t.due_at && dayIndex(zoned(t.due_at, tz)) === dayIndex(zoned(now, tz));
const short = (s, n = 14) => (s.length > n ? s.slice(0, n) + '…' : s);

/** 单条提醒 / 催办 */
export function reminderMessage({ reminder, todo, task, waitingName, now = new Date(), tz }) {
  const url = `/#/today?todo=${todo.id}`;
  if (reminder.kind === 'nudge') {
    const days = todo.waiting_since ? Math.max(0, dayIndex(zoned(now, tz)) - dayIndex(zoned(todo.waiting_since, tz))) : 0;
    let left = '';
    if (task && task.end_date) { const [y, m, d] = task.end_date.split('-').map(Number); const l = Date.UTC(y, m - 1, d) / 86400000 - dayIndex(zoned(now, tz)); left = l >= 0 ? ` · 项目剩 ${l} 天` : ' · 项目已过结束日'; }
    return { title: `催办：${todo.title}`, body: `已等${waitingName ? ' ' + waitingName : '对方'} ${days} 天${left}，记得跟进`, url, tag: `todo-${todo.id}` };
  }
  const due = dueText(todo.due_at, todo.due_all_day, now, tz);
  const head = reminder.kind === 'at_time' ? '到点了' : '快到期';
  return { title: `${head}：${todo.title}`, body: [due && `截止 ${due}`, task && task.title].filter(Boolean).join(' · ') || '点开查看', url, tag: `todo-${todo.id}` };
}

/** 早报 / 晚报。todos 为该用户全部待办（含已完成） */
export function digestMessage(kind, { todos, now = new Date(), tz }) {
  const open = todos.filter(t => t.status !== 'done');
  const overdue = open.filter(t => isOverdue(t, now, tz));
  const today = open.filter(t => !isOverdue(t, now, tz) && isDueToday(t, now, tz) && t.status !== 'waiting');
  const waiting = open.filter(t => t.status === 'waiting');
  if (kind === 'morning') {
    const top = [...overdue, ...today].sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9)).slice(0, 3).map(t => short(t.title));
    const parts = [];
    if (overdue.length) parts.push(`逾期 ${overdue.length}`);
    parts.push(`今天到期 ${today.length}`);
    if (waiting.length) parts.push(`等待他人 ${waiting.length}`);
    const title = overdue.length + today.length ? `早报：今天 ${today.length} 件到期${overdue.length ? `，${overdue.length} 件逾期` : ''}` : '早报：今天没有到期的待办';
    return { title, body: parts.join(' · ') + (top.length ? `\n${top.join('；')}` : ''), url: '/#/today', tag: 'digest-morning' };
  }
  const doneToday = todos.filter(t => t.status === 'done' && t.completed_at && dayIndex(zoned(t.completed_at, tz)) === dayIndex(zoned(now, tz)));
  const tomorrow = open.filter(t => t.due_at && dayIndex(zoned(t.due_at, tz)) === dayIndex(zoned(now, tz)) + 1);
  const left = today.length + overdue.length;
  return {
    title: `晚报：今天完成 ${doneToday.length} 件`,
    body: [left ? `还剩 ${left} 件未完成` : '今天的都做完了', tomorrow.length ? `明天到期 ${tomorrow.length} 件` : '', waiting.length ? `等待他人 ${waiting.length}` : ''].filter(Boolean).join(' · '),
    url: '/#/today?review=1', tag: 'digest-evening',
  };
}

/**
 * 早/晚报是否该发：已到设定时间、今天还没发过、且没超过补发窗口（默认 3 小时，避免半夜补发早报）
 */
export function digestDue(settings, kind, now = new Date(), windowMin = 180) {
  const on = kind === 'morning' ? settings.morning_on : settings.evening_on;
  if (!on) return false;
  const tz = settings.timezone || 'Asia/Shanghai';
  const z = zoned(now, tz);
  const [h, m] = String(kind === 'morning' ? settings.morning_time : settings.evening_time).split(':').map(Number);
  const minsNow = z.h * 60 + z.min, minsAt = h * 60 + m;
  const last = kind === 'morning' ? settings.last_morning_sent : settings.last_evening_sent;
  return minsNow >= minsAt && minsNow - minsAt <= windowMin && last !== z.key;
}
