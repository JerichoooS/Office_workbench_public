// parse.js — 快速记录的中文时间识别（纯本地规则，不依赖 AI）
// 输入：「明天下午3点提醒我交周报」
// 输出：{ title:'交周报', due:Date|null, allDay:bool, remind:bool, label:'明天 15:00', waiting:bool, repeat:null, notes:null }
//   repeat：「每周一」「每天」「每个工作日」「每月5号」→ 与 todos.repeat_rule 同形（见 data/schema.js repeatLabel），due 是第一次
//   notes：长文本（多行 / 好几句，如转发的微信通知）= 原文整段；title 取第一句。短句为 null
// AI 开启时，可在此结果基础上再请模型补全（见 ai.js），规则解析始终是兜底。
// 改规则先加用例：node server/test/parse.test.mjs
// 不用正则后行断言（?<…）：旧版 iOS Safari 不认，整个模块会加载失败；「前一个字」改在 ok() 里判断。

import { addDays, startOfDay, WD } from './dates.js';
import { isWorkday } from './holidays.js';   // 「每个工作日」的第一次：跳过法定节假日，调休上班日算

const CN = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
/** 「15」「两」「十一」「二十五」「廿五」→ 数字；认不出 → NaN */
const toNum = s => {
  if (/^\d+$/.test(s)) return +s;
  const p = s.replace(/^廿/, '二十').replace(/^卅/, '三十').split('十');
  if (p.length === 1) return s.length === 1 && s in CN ? CN[s] : NaN;
  return p.length === 2 && p[0].length < 2 && p[1].length < 2 ? (p[0] ? CN[p[0]] : 1) * 10 + (p[1] ? CN[p[1]] : 0) : NaN;   // CN 里没有 → undefined → NaN
};
const WD_MAP = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
const N = '(\\d{1,2}|[零〇一二两三四五六七八九十廿卅]{1,3})';
const re = src => new RegExp(src, 'g');
// 删掉的说法用细空格 \u2009 占位（\s 认得它，前后文判断照常）；收尾时夹在两个汉字之间的占位直接去掉：「材料月底前报送」→「材料报送」，不会变成「材料 报送」
const GAP = '\u2009', HAN = '[\u3000-\u9fff\uff00-\uffef]', GAP_HAN = new RegExp(`(${HAN})${GAP}+(?=${HAN})`, 'g');
const AP = '(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|半夜|夜里|深夜)';
const AP_END = new RegExp(AP + '\\s*$');

// 「号」后面跟这些字是场馆/房间/设备编号（9.2号馆、1号机房、A3号门、3号文），不是日期
const VENUE = /^(?:[馆楼厅房门口位线台柜架桌区座栋幢层室仓库车井塔站间箱杆岗场舱梯窗文]|机|展[位馆厅台])/;
// 小数后面跟单位（2.5小时、1.5万、3.5G、2.0版）不是「月.日」
const UNIT = /^(?:[\d.．%％A-Za-z]|\s*(?:小时|分钟?|秒|天|周|个|次|倍|元|块|[万亿千百]|米|公里|[斤吨度寸折成版期届级兆伏瓦岁年]))/;
// 「12.1馆」「12.2 馆」「12.1–12.2 馆」：场馆编号常不写「号」，也不是「月.日」
const HALL = /^(?:\s*号?\s*[馆楼厅]|\s*[–—\-~～至到、和]\s*\d{1,2}[.．]\d{1,2}\s*号?\s*[馆楼厅])/;
// 日期/时刻后紧跟的「前 / 之前 / 截止」一并去掉（「周五前交采购清单」→「交采购清单」）；「前往」「前台」不算
const BEFORE = /^\s*(?:之前|以前|为止|截止|前(?![后天面期台端置往去方夕程途线沿门厅]))/;
// 日期前悬空的「请于」「截止」「最晚」（「请于10月25日前报送」→「报送」）；「关于」不动（要求前面是句首或标点）
const DANGLE = /(^|[\s，,。：:；;、])(?:(?:截止|截至)(?:到|于|日期)?|最晚|最迟|(?:请|务必|须|需)?于)\s*$/;
// 「等」开头但不是「等别人」：等保测评、等电位、等候区、等一下……
const NOT_WAIT = /^等(?:保|级|电位|候|待区|离子|比|高|同|效|于|额|分|量|边|距|腰|号|式|价|宽|长|速|温|压|值|会儿?|一会|一下)/;
const WAIT_ON = /^等.{1,10}?(?:回复|回话|回电|回音|确认|反馈|答复|通知|消息|结果|审批|批复|签字|盖章|报价|到货|发货)/;

/** 标题是不是「等待他人」：催 xx / 等 xx（排除等保、等电位……） */
export function isWaiting(t) {
  if (/(?:^|[，,；;：:\s])(?:再|去|打电话|电话|微信)?催(?!化|眠|泪|生|熟)/.test(t)) return true;
  if (/^等/.test(t) && !NOT_WAIT.test(t)) return true;
  return [...t.matchAll(/(?:^|[，,；;\s])等/g)].some(m => { const x = t.slice(m.index).replace(/^[，,；;\s]/, ''); return !NOT_WAIT.test(x) && WAIT_ON.test(x); });
}

/** 重复规则的第一次：从今天起第一个符合的日子（今天的时刻已过则往后找） */
function firstRepeat(r, today, time, now) {
  const passed = time && time.h * 60 + time.m < now.getHours() * 60 + now.getMinutes();
  const fit = d => r.freq === 'daily' || (r.freq === 'weekdays' ? isWorkday(d.getFullYear(), d.getMonth() + 1, d.getDate()) : r.freq === 'weekly' ? r.days.includes(d.getDay())
    : d.getDate() === Math.min(r.day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  for (let i = passed ? 1 : 0; i < 62; i++) { const d = addDays(today, i); if (fit(d)) return d; }
  return today;
}
/** 本月（或往后第 k 个月）的第 d 天；没有 31 号的月份取月底 */
const dayOfMonth = (y, mo, d) => new Date(y, mo, Math.min(d, new Date(y, mo + 1, 0).getDate()));

export function parseQuick(input, now = new Date()) {
  const raw = String(input || '').trim();
  let s = ' ' + raw + ' ';
  let day = null, time = null, remind = false, repeat = null, eve = false, morn = false, m;
  const today = startOfDay(now);
  /** 找第一个 ok() 认可的匹配（ok 收到 匹配、前文、后文，返回值存到 m.v） */
  const find = (r, ok = () => true) => { for (const x of s.matchAll(r)) { const v = ok(x, s.slice(0, x.index), s.slice(x.index + x[0].length)); if (v) { x.v = v; return x; } } return null; };
  /** 按位置删掉（不用 replace(文字)：同样的字可能在前面出现过）；deadline=日期时刻，顺带吃掉「前」「请于」 */
  const cut = (x, extra = 0, deadline = true) => {
    let a = s.slice(0, x.index), b = s.slice(x.index + x[0].length + extra), k;
    if (deadline) { if ((k = b.match(BEFORE))) b = b.slice(k[0].length); a = a.replace(DANGLE, '$1'); }
    s = a + GAP + b;
  };
  const dayWord = w => { if (/晚|夜/.test(w)) { eve = true; time = { h: 20, m: 0, soft: true }; } if (/早/.test(w)) morn = true; if (w.startsWith('明早')) time = { h: 9, m: 0, soft: true }; };

  // 重复（先于日期：免得「每周一」「每月5号」被当成单次的周一、5号）
  if ((m = find(re('每一?天|每日')))) { repeat = { freq: 'daily' }; cut(m); }
  else if ((m = find(re('每个?工作日|工作日每天')))) { repeat = { freq: 'weekdays' }; cut(m); }
  else if ((m = find(re('每个?(?:周|星期|礼拜)((?:[、,，和及]?(?:周|星期)?[一二三四五六日天])+)')))) {
    repeat = { freq: 'weekly', days: [...new Set(m[1].match(/[一二三四五六日天]/g).map(c => WD_MAP[c]))].sort((a, b) => a - b) }; cut(m);
  } else if ((m = find(re(`每个?月(?:${N}[号日]|[底末]|最后一天)`), x => !x[1] || (toNum(x[1]) >= 1 && toNum(x[1]) <= 31)))) {
    repeat = { freq: 'monthly', day: m[1] ? toNum(m[1]) : 31 }; cut(m);   // 每月底 = 31，生成下一次时按当月天数截到月底（schedule.js）
  }

  // 日期（只认第一种说法）
  if (repeat) { /* 第一次的日期等时刻识别完再算 */ }
  else if ((m = find(re('今天|今日|今晚上?|今早上?|今夜')))) { day = today; dayWord(m[0]); cut(m); }
  else if ((m = find(re('明天|明日|明早上?|明晚上?')))) { day = addDays(today, 1); dayWord(m[0]); cut(m); }
  else if ((m = find(re('大后天')))) { day = addDays(today, 3); cut(m); }
  else if ((m = find(re('后天')))) { day = addDays(today, 2); cut(m); }
  else if ((m = find(re('(下下个?|下个?|这个?|本)?(?:周|星期|礼拜)([一二三四五六日天])'), (x, b) => !/(?:上|每)个?$/.test(b)))) {
    const target = WD_MAP[m[2]], pre = m[1] || '', mon = (now.getDay() + 6) % 7;   // 下周 / 下下周按「周一开始」算
    let diff = (target - now.getDay() + 7) % 7;
    if (pre.startsWith('下下')) diff = ((target + 6) % 7) - mon + 14;
    else if (pre.startsWith('下')) diff = ((target + 6) % 7) - mon + 7;
    day = addDays(today, diff); cut(m);
  } else if ((m = find(re(`(?:(下个?|这个?|本)|${N})?月(?:[底末]|最后一天)`), x => !x[2] || (toNum(x[2]) >= 1 && toNum(x[2]) <= 12)))) {
    const mo = m[2] ? toNum(m[2]) : now.getMonth() + 1 + (m[1] && m[1][0] === '下' ? 1 : 0);   // 月底 = 那个月最后一天（全天）；「10月底」按 10 月
    day = new Date(now.getFullYear(), mo, 0); if (day < today) day = new Date(now.getFullYear() + 1, mo, 0);
    cut(m);
  } else if ((m = find(re(`(下个?|这个?|本)月${N}[号日]`), x => toNum(x[2]) >= 1 && toNum(x[2]) <= 31))) {
    day = dayOfMonth(now.getFullYear(), now.getMonth() + (m[1][0] === '下' ? 1 : 0), toNum(m[2])); cut(m);
  } else if ((m = find(re(`(?:(\\d{4})年)?${N}月${N}([日号])?`), (x, b) => {
    const mo = toNum(x[2]), d = toNum(x[3]);
    return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && (/\d/.test(x[3]) || x[4]) && !/[\d.．]$/.test(b);   // 中文的日要带「日/号」：「一月一次」不算
  }))) {
    day = new Date(m[1] ? +m[1] : now.getFullYear(), toNum(m[2]) - 1, toNum(m[3]));
    if (!m[1] && day < today) day.setFullYear(day.getFullYear() + 1);
    cut(m);
  } else if ((m = find(re('(?:(\\d{4})[.．])?(\\d{1,2})[.．](\\d{1,2})([日号])?'), (x, b, a) => {
    const mo = +x[2], d = +x[3];
    // 10.25 = 10月25日；9.2号馆、2.5小时、V2.3、10.1.1.1、「下午3.30」都不是
    return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && !/[\dA-Za-z.．]$/.test(b) && !AP_END.test(b)
      && !VENUE.test(a) && !HALL.test(a) && !(!x[4] && UNIT.test(a));
  }))) {
    day = new Date(m[1] ? +m[1] : now.getFullYear(), +m[2] - 1, +m[3]);
    if (!m[1] && day < today) day.setFullYear(day.getFullYear() + 1);
    cut(m);
  } else if ((m = find(re(`${N}([号日])`), (x, b, a) => {
    const d = toNum(x[1]);
    // 25号 / 二十号 = 当月；3号馆、1号机房、A3号门、第3号不是；中文数字配「日」要带十（「三日内」不算）
    return d >= 1 && d <= 31 && !/[\dA-Za-z.．第#＃]$/.test(b) && !(x[2] === '号' && VENUE.test(a)) && (/\d/.test(x[1]) || x[2] === '号' || x[1].includes('十'));
  }))) {
    day = dayOfMonth(now.getFullYear(), now.getMonth(), toNum(m[1]));
    if (day < today) day = dayOfMonth(now.getFullYear(), now.getMonth() + 1, toNum(m[1]));
    cut(m);
  } else if ((m = find(re('(\\d+|[一二三四五六七八九十两]+)天[后以]后?'), x => toNum(x[1]) >= 0))) { day = addDays(today, toNum(m[1])); cut(m); }

  // 时刻：下午3点半 / 15:30 / 晚上8点 / 10点20 / 3点钟；「5点位」「早一点」「这两点」不是
  if ((m = find(re(`${AP}?\\s*${N}\\s*(?:([:：.．])\\s*(\\d{2})(?!\\d)|[点時时](?:钟|整)?)`), (x, b, a) => {
    const ap = x[1] || '', cnHour = !/\d/.test(x[2]);
    let h = toNum(x[2]), min = 0, extra = 0;
    if (isNaN(h)) return null;
    if (/[.．]/.test(x[3] || '') && !ap) return null;   // 3.30 没说上午下午 → 是日期（上面已处理），这里不当时刻
    if (!ap && (cnHour ? !/(?:^|[\s，,。：:；;、！!？?（(])$/.test(b) : /[\dA-Za-z.．第#＃]$/.test(b))) return null;
    if (x[3]) min = +x[4];
    else {
      if (/^[位子儿滴数线面状式阵]/.test(a) || (x[2] === '一' && /^点/.test(a))) return null;   // 5点位、一点点
      const k = a.match(/^(半|一刻|三刻|\d{1,2}(?![\d个人台份次号件条位名天])分?|[二三四五]?十[一二三四五六七八九]?分?|零?[一二三四五六七八九]分)?(?:多|左右)?/);
      const v = k[1] || '';
      min = v === '半' ? 30 : v === '一刻' ? 15 : v === '三刻' ? 45 : v ? toNum(v.replace(/[分零]/g, '')) : 0;
      extra = k[0].length;
    }
    if (/下午|傍晚|晚上|半夜|夜里|深夜/.test(ap) || (!ap && eve)) h = h === 12 && !/下午|傍晚/.test(ap) ? 24 : h < 12 ? h + 12 : h;   // 晚上12点 = 当天最后一刻
    else if (ap === '中午' && h < 6) h += 12;
    else if (ap === '凌晨' && h === 12) h = 0;
    else if (!ap && !morn && h >= 1 && h <= 6) h += 12;   // 用户确认：没说上午下午的 1~6 点按下午（「2点复测」= 14:00）
    if (h === 24) return { h: 23, m: 59, extra };
    return h < 24 && min < 60 ? { h, m: min, extra } : null;
  }))) { time = { h: m.v.h, m: m.v.m }; cut(m, m.v.extra); }
  else if ((m = find(re('下班(?:之前|以前|前)')))) { time = { h: 17, m: 30 }; cut(m); }   // 用户确认：下班前 = 17:30
  else if ((m = find(re('(早上|早晨|上午|中午|下午|傍晚|晚上)')))) {
    time = { h: { 早上: 9, 早晨: 9, 上午: 10, 中午: 12, 下午: 15, 傍晚: 18, 晚上: 20 }[m[1]], m: 0, soft: true }; cut(m);
  }

  // 相对时间：10分钟后 / 2小时后 / 半小时后
  let rel = null;
  if (!time && !repeat && (m = find(re('(\\d+|[一二三四五六七八九十两半]+)\\s*(分钟|小时|个小时)[后以]后?'), x => x[1] === '半' || !isNaN(toNum(x[1]))))) {
    rel = new Date(now.getTime() + (m[1] === '半' ? 0.5 : toNum(m[1])) * (m[2] === '分钟' ? 60000 : 3600000)); cut(m, 0, false);
  }

  if ((m = find(re('提醒我|提醒一下|叫我|记得')))) { remind = true; cut(m, 0, false); }

  if (repeat) day = firstRepeat(repeat, today, time, now);
  else if (time && !day) { day = today; if (time.h * 60 + time.m < now.getHours() * 60 + now.getMinutes()) day = addDays(day, 1); }
  let due = null, allDay = true;
  if (rel) { due = rel; allDay = false; }
  else if (day) { due = new Date(day); if (time) { due.setHours(time.h, time.m, 0, 0); allDay = false; } else due.setHours(23, 59, 0, 0); }

  // 标题：去掉时间说法后剩下的字。长文本（多行 / 好几句）→ 第一句有内容的话做标题（≤40 字），原文整段进备注
  const clean = x => x.replace(GAP_HAN, '$1').replace(/\s+/g, ' ').replace(/([，,、；;])\s*[，,、；;]/g, '$1').replace(/^[\s，,。、:：;；!！?？]+|[\s，,。、:：;；]+$/g, '').trim();
  const body = clean(s);
  const long = /\n/.test(raw) || body.length > 40 || (body.length > 20 && body.split(/[。！？!?；;]/).filter(x => x.trim()).length > 1);
  let title = body || raw;
  if (long) {
    const segs = s.split(/[\n。！？!?；;]+/).filter(x => !/[：:]\s*$/.test(x))   // 「各单位：」「时间：」这种抬头行跳过
      .map(x => clean(x.replace(/^\s*@\S+\s*/, '').replace(/^\s*【[^】]{0,10}】/, '').replace(/^\s*[^\s：:，,]{1,10}[：:](?=\s*\S)/, '')));
    const GREET = /^(?:各位|大家|您|你们?)好|^(?:谢谢|辛苦了?|收到|如下)/;
    title = segs.find(x => x.length >= 4 && !GREET.test(x)) || segs.find(x => x.length >= 2) || title;
    if (title.length > 40) title = title.slice(0, 39) + '…';
  }
  let label = '';
  if (due) {
    const diff = Math.round((startOfDay(due) - today) / 86400000);
    const w = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === 2 ? '后天' : `${due.getMonth() + 1}/${due.getDate()} 周${WD[due.getDay()]}`;
    label = allDay ? w : `${w} ${String(due.getHours()).padStart(2, '0')}:${String(due.getMinutes()).padStart(2, '0')}`;
  }
  return { title, due, allDay, remind: remind || (!!due && !allDay), label, waiting: isWaiting(title), repeat, notes: long ? raw : null };
}
