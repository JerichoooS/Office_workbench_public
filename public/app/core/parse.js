// parse.js — 快速记录的中文时间识别（纯本地规则，不依赖 AI）
// 输入：「明天下午3点提醒我交周报」
// 输出：{ title:'交周报', due:Date|null, allDay:bool, remind:bool, label:'明天 15:00', waiting:bool }
// AI 开启时，可在此结果基础上再请模型补全（见 ai.js），规则解析始终是兜底。

import { addDays, startOfDay, WD } from './dates.js';

const CN_NUM = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
const toNum = s => (/^\d+$/.test(s) ? +s : CN_NUM[s] ?? (s.startsWith('十') ? 10 + (CN_NUM[s.slice(1)] || 0) : NaN));
const WD_MAP = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };

export function parseQuick(input, now = new Date()) {
  let s = ' ' + input.trim() + ' ';
  let day = null, time = null, remind = false, evening = false;
  const cut = re => { const m = s.match(re); if (m) s = s.replace(m[0], ' '); return m; };
  let m;

  // 日期
  if ((m = cut(/今天|今日|今晚|今早/))) { day = startOfDay(now); if (/晚/.test(m[0])) { time = { h: 20, m: 0, soft: true }; evening = true; } }
  else if ((m = cut(/明天|明日|明早|明晚/))) { day = addDays(startOfDay(now), 1); if (/晚/.test(m[0])) { time = { h: 20, m: 0, soft: true }; evening = true; } if (/早/.test(m[0])) time = { h: 9, m: 0, soft: true }; }
  else if ((m = cut(/大后天/))) day = addDays(startOfDay(now), 3);
  else if ((m = cut(/后天/))) day = addDays(startOfDay(now), 2);
  else if ((m = cut(/(下下周|下周|这周|本周|周|星期|礼拜)([一二三四五六日天])/))) {
    const target = WD_MAP[m[2]];
    let diff = (target - now.getDay() + 7) % 7;
    if (m[1] === '下周') diff = ((target + 6) % 7) - ((now.getDay() + 6) % 7) + 7;
    else if (m[1] === '下下周') diff = ((target + 6) % 7) - ((now.getDay() + 6) % 7) + 14;
    else if (diff === 0 && !/这周|本周/.test(m[1])) diff = 0;
    day = addDays(startOfDay(now), diff);
  } else if ((m = cut(/(\d{1,2})月(\d{1,2})[日号]?/))) {
    day = new Date(now.getFullYear(), +m[1] - 1, +m[2]);
    if (day < startOfDay(now)) day.setFullYear(day.getFullYear() + 1);
  } else if ((m = cut(/(\d{1,2})[号日]/))) {
    day = new Date(now.getFullYear(), now.getMonth(), +m[1]);
    if (day < startOfDay(now)) day.setMonth(day.getMonth() + 1);
  } else if ((m = cut(/(\d+|[一二三四五六七八九十两]+)天[后以]后?/))) day = addDays(startOfDay(now), toNum(m[1]));

  // 时刻：下午3点半 / 15:30 / 晚上8点 / 10点20
  if ((m = cut(/(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2}|[一二三四五六七八九十两]{1,3})\s*(?:[:：]\s*(\d{2})|[点時时]\s*(半|一刻|三刻|(\d{1,2}|[一二三四五六七八九十]{1,3})分?)?)/))) {
    let h = toNum(m[2]);
    const ap = m[1] || '';
    let min = m[3] ? +m[3] : m[4] === '半' ? 30 : m[4] === '一刻' ? 15 : m[4] === '三刻' ? 45 : m[5] ? toNum(m[5]) : 0;
    if ((/下午|傍晚|晚上/.test(ap) || (!ap && evening)) && h < 12) h += 12;
    if (ap === '中午' && h < 6) h += 12;
    if (!isNaN(h) && h < 24 && min < 60) time = { h, m: min };
  } else if ((m = cut(/(早上|上午|中午|下午|晚上)(?!\d)/))) {
    time = { h: { 早上: 9, 上午: 10, 中午: 12, 下午: 15, 晚上: 20 }[m[1]], m: 0, soft: true };
  }

  // 相对时间：10分钟后 / 2小时后 / 半小时后
  let rel = null;
  if (!time && (m = cut(/(\d+|[一二三四五六七八九十两半]+)\s*(分钟|小时|个小时)[后以]后?/))) {
    const n = m[1] === '半' ? 0.5 : toNum(m[1]);
    if (!isNaN(n)) rel = new Date(now.getTime() + n * (m[2] === '分钟' ? 60000 : 3600000));
  }

  if ((m = cut(/提醒我|提醒一下|叫我|记得/))) remind = true;

  if (time && !day) { day = startOfDay(now); if (time.h * 60 + time.m < now.getHours() * 60 + now.getMinutes()) day = addDays(day, 1); }
  let due = null, allDay = true;
  if (rel) { due = rel; allDay = false; day = startOfDay(rel); }
  else if (day) { due = new Date(day); if (time) { due.setHours(time.h, time.m, 0, 0); allDay = false; } else due.setHours(23, 59, 0, 0); }

  const titleRaw = s.replace(/\s+/g, ' ').replace(/^[\s，,。:：]+|[\s，,。]+$/g, '').trim() || input.trim();
  const title = titleRaw;
  const waiting = /^(催|等)|等.{1,8}(回复|回|确认|反馈)/.test(title);
  let label = '';
  if (due) {
    const diff = Math.round((startOfDay(due) - startOfDay(now)) / 86400000);
    const w = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === 2 ? '后天' : `${due.getMonth() + 1}/${due.getDate()} 周${WD[due.getDay()]}`;
    label = allDay ? w : `${w} ${String(due.getHours()).padStart(2, '0')}:${String(due.getMinutes()).padStart(2, '0')}`;
  }
  return { title, due, allDay, remind: remind || (!!due && !allDay), label, waiting };
}
