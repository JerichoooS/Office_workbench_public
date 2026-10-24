// schedule.js — 提醒与催办的时间计算（纯函数，前端与 server.js 共用）
//
// 催办节奏（用户确认：按项目起止时间的剩余进度安排）：
//   项目时间已过 < 50%  → 每 3 天催一次
//   50% ~ 80%           → 每 2 天
//   > 80% 或已过结束日   → 每天
//   没有所属项目 / 项目没设起止 → 每 2 天
// 催办时刻固定在当天 09:00；如果算出来的时间早于现在，顺延到下一个 09:00。
// 落在非工作日（周末、法定节假日；调休上班日算工作日，见 core/holidays.js）顺延到下一个工作日的 09:00。
//
// 时区：tz 省略 = 本机时区（前端，手机就在用户所在地）；服务器必须传用户时区（user_settings.timezone，
// 默认 Asia/Shanghai），否则 UTC 服务器上的「项目开始的 0 点」比手机晚 8 小时，算出的催办间隔会和手机不一致。

import { isWorkday } from './holidays.js';

export const NUDGE_HOUR = 9;

/** tz 时区里 y-m-d h:mi（墙上时间）对应的真实时刻；d 可越界（Date.UTC 自动进位，用来加减天数） */
function wallTime(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(guess)).map(x => [x.type, +x.value]));
  return new Date(guess - (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - guess));   // 减去 tz 相对 UTC 的偏移
}

/** 'YYYY-MM-DD' 那天 0 点（tz 省略 = 本机时区） */
function dayStart(s, tz) {
  const [y, m, d] = s.split('-').map(Number);
  return tz ? wallTime(y, m, d, 0, 0, tz) : new Date(y, m - 1, d);
}

/** 项目时间进度 0~1（开始日 0 点 → 结束日 23:59:59）；没设起止返回 null */
export function taskProgress(task, now = new Date(), tz) {
  if (!task || !task.start_date || !task.end_date) return null;
  const s = dayStart(task.start_date, tz), e = new Date(dayStart(task.end_date, tz).getTime() + 86399000);
  if (e <= s) return 1;
  return Math.min(Math.max((now - s) / (e - s), 0), 1);
}

export function nudgeIntervalDays(task, now = new Date(), tz) {
  const p = taskProgress(task, now, tz);
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

/** date 在 tz 时区（省略 = 本机）是哪年哪月哪日 */
function dayParts(date, tz) {
  if (!tz) { const d = new Date(date); return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() }; }
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(date)).map(x => [x.type, +x.value]));
  return { y: p.year, m: p.month, d: p.day };
}
/** date 所在的那一天（tz 时区）是不是工作日 */
export function workdayAt(date, tz) { const p = dayParts(date, tz); return isWorkday(p.y, p.m, p.d); }

/** 下一次催办时间。from = 上次催办或开始等待的时间；tz = 用户时区（服务器端必须传）。非工作日顺延到下一个工作日 09:00 */
export function nextNudgeAt(task, from, now = new Date(), tz) {
  const days = nudgeIntervalDays(task, now, tz);
  let at = atHourInTz(new Date(new Date(from || now).getTime() + days * 86400000), NUDGE_HOUR, tz);
  if (at <= now) {
    at = atHourInTz(now, NUDGE_HOUR, tz);
    if (at <= now) at = atHourInTz(new Date(now.getTime() + 86400000), NUDGE_HOUR, tz);
  }
  for (let i = 0; i < 40 && !workdayAt(at, tz); i++) at = atHourInTz(new Date(at.getTime() + 86400000), NUDGE_HOUR, tz);
  return at;
}

/**
 * 「截止前 minutes 分钟」的提醒时刻——所有地方（新建、改截止、详情里加提醒、套用项目）都用这一个函数。
 * 有时刻的待办：截止时刻往前推 minutes 分钟（0 = 准时）。
 * 全天的待办（用户确认的规则）：一律在早上 09:00 提醒——
 *   minutes 是 N 个整天（1440 = 1 天）→ 截止日往前 N 天的 09:00（「截止前 1 天」= 前一天 09:00）；
 *   不足一天（15 分钟 / 1 小时 / 0）→ 截止当天 09:00。
 * tz 省略 = 本机时区（前端）；服务器端要算时传用户时区。返回 Date；没有截止时间或 minutes 为空返回 null。
 */
export function beforeDueAt(dueAt, allDay, minutes, tz) {
  if (!dueAt || minutes == null) return null;
  if (!allDay) return new Date(new Date(dueAt).getTime() - minutes * 60000);
  const days = Math.floor(minutes / 1440);
  if (!tz) { const d = new Date(dueAt); d.setDate(d.getDate() - days); d.setHours(NUDGE_HOUR, 0, 0, 0); return d; }
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(dueAt)).map(x => [x.type, +x.value]));
  return wallTime(p.year, p.month, p.day - days, NUDGE_HOUR, 0, tz);
}

// ---------- 重复待办 ----------
// 用户确认（小规则 1）：补完逾期的那一期后，今天这一期照常保留——下一次 = 原截止日之后、且不早于今天的第一期（今天也算）。
// 跳过的期数（原截止日和下一次之间的那几期）用 repeatSkipped() 算，界面提示「已跳过 N 期」。
// 「每个工作日」按 core/holidays.js：法定节假日不生成，调休上班日照常生成。时刻沿用原来的截止时刻。

const dayStartLocal = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

function occurs(rule, d, base) {
  if (rule.freq === 'daily') return true;
  if (rule.freq === 'weekdays') return isWorkday(d.getFullYear(), d.getMonth() + 1, d.getDate());
  if (rule.freq === 'weekly') return (rule.days && rule.days.length ? rule.days : [base.getDay()]).includes(d.getDay());
  if (rule.freq === 'monthly') return d.getDate() === Math.min(rule.day || base.getDate(), new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate());
  return false;
}
const REPEAT = ['daily', 'weekdays', 'weekly', 'monthly'];

/** 重复待办：完成后计算下一次截止时间（本机时区）；不认识的规则返回 null */
export function nextRepeatDue(rule, prevDue, now = new Date()) {
  if (!rule || !REPEAT.includes(rule.freq)) return null;
  const base = new Date(prevDue || now), today = dayStartLocal(now);
  for (let i = 1; i <= 800; i++) {
    const d = new Date(base); d.setDate(base.getDate() + i);
    if (dayStartLocal(d) >= today && occurs(rule, d, base)) return d;
  }
  return null;
}

/** 原截止日和下一次之间跳过了几期（补交逾期的重复待办时提示用） */
export function repeatSkipped(rule, prevDue, next) {
  if (!rule || !REPEAT.includes(rule.freq) || !prevDue || !next) return 0;
  const base = new Date(prevDue), end = dayStartLocal(next);
  let n = 0;
  for (let i = 1; i <= 800; i++) {
    const d = new Date(base); d.setDate(base.getDate() + i);
    if (dayStartLocal(d) >= end) break;
    if (occurs(rule, d, base)) n++;
  }
  return n;
}
