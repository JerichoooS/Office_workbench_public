// schedule.js — 提醒与催办的时间计算（纯函数，前端与 server.js 共用）
//
// 催办节奏（用户确认：按项目起止时间的剩余进度安排）：
//   项目时间已过 < 50%  → 每 3 天催一次
//   50% ~ 80%           → 每 2 天
//   > 80% 或已过结束日   → 每天
//   没有所属项目 / 项目没设起止 → 每 2 天
// 催办时刻固定在当天 09:00；如果算出来的时间早于现在，顺延到下一个 09:00。

export const NUDGE_HOUR = 9;

export function taskProgress(task, now = new Date()) {
  if (!task || !task.start_date || !task.end_date) return null;
  const s = new Date(task.start_date + 'T00:00:00'), e = new Date(task.end_date + 'T23:59:59');
  if (e <= s) return 1;
  return Math.min(Math.max((now - s) / (e - s), 0), 1);
}

export function nudgeIntervalDays(task, now = new Date()) {
  const p = taskProgress(task, now);
  if (p === null) return 2;
  if (p < 0.5) return 3;
  if (p < 0.8) return 2;
  return 1;
}

/** 把 date 所在「tz 时区的那一天」的 hour 点整转成真实时间（tz 省略 = 本机时区，前端用） */
export function atHourInTz(date, hour, tz) {
  if (!tz) { const d = new Date(date); d.setHours(hour, 0, 0, 0); return d; }
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(date)).map(x => [x.type, +x.value]));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const offset = asUtc - Math.floor(new Date(date).getTime() / 60000) * 60000;   // tz 相对 UTC 的偏移
  return new Date(Date.UTC(p.year, p.month - 1, p.day, hour, 0) - offset);
}

/** 下一次催办时间。from = 上次催办或开始等待的时间；tz = 用户时区（服务器端必须传） */
export function nextNudgeAt(task, from, now = new Date(), tz) {
  const days = nudgeIntervalDays(task, now);
  let at = atHourInTz(new Date(new Date(from || now).getTime() + days * 86400000), NUDGE_HOUR, tz);
  if (at <= now) {
    at = atHourInTz(now, NUDGE_HOUR, tz);
    if (at <= now) at = atHourInTz(new Date(now.getTime() + 86400000), NUDGE_HOUR, tz);
  }
  return at;
}

/** 截止前提醒时间；全天的待办按当天 09:00 计 */
export function beforeDueAt(dueAt, allDay, minutes) {
  if (!dueAt || minutes == null) return null;
  const d = new Date(dueAt);
  if (allDay) d.setHours(NUDGE_HOUR, 0, 0, 0);
  return new Date(d.getTime() - (allDay ? 0 : minutes * 60000));
}

/** 重复待办：完成后计算下一次截止时间 */
export function nextRepeatDue(rule, prevDue, now = new Date()) {
  if (!rule) return null;
  const base = new Date(prevDue || now);
  const keepTime = d => { d.setHours(base.getHours(), base.getMinutes(), 0, 0); return d; };
  const start = new Date(Math.max(base, now));
  if (rule.freq === 'daily') { const d = new Date(start); d.setDate(d.getDate() + 1); return keepTime(d); }
  if (rule.freq === 'weekdays' || rule.freq === 'weekly') {
    const days = rule.freq === 'weekdays' ? [1, 2, 3, 4, 5] : (rule.days && rule.days.length ? rule.days : [base.getDay()]);
    for (let i = 1; i <= 14; i++) { const d = new Date(start); d.setDate(d.getDate() + i); if (days.includes(d.getDay())) return keepTime(d); }
  }
  if (rule.freq === 'monthly') {
    const d = new Date(start); d.setDate(1); d.setMonth(d.getMonth() + 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(rule.day || base.getDate(), last));
    return keepTime(d);
  }
  return null;
}
