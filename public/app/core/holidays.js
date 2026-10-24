// holidays.js — 法定节假日与调休上班日（前端与 server.js 共用，纯数据 + 纯函数）
//
// 用户确认（2026-10-22）：「工作日」不只是周一到周五——法定节假日不算，调休上班的周六周日照算。
// 用在：自动催办（落在非工作日顺延到下一个工作日）、「每个工作日」重复。
//
// 每年 11 月前后国务院办公厅公布下一年的安排，公布后在 DATA 里补一年（照下面的格式，日期都写 'MM-DD'）。
// 没有数据的年份只按周末算（周一到周五是工作日），设置 › 数据与备份里会提示「节假日表只到 XXXX 年」。

const DATA = {
  // 国务院办公厅关于2026年部分节假日安排的通知（2025-11-04）
  2026: {
    off: [['01-01', '01-03'], ['02-15', '02-23'], ['04-04', '04-06'], ['05-01', '05-05'], ['06-19', '06-21'], ['09-25', '09-27'], ['10-01', '10-07']],
    work: ['01-04', '02-14', '02-28', '05-09', '09-20', '10-10'],
  },
};

const pad = n => String(n).padStart(2, '0');
const sets = {};
function yearSets(y) {
  if (sets[y] !== undefined) return sets[y];
  const d = DATA[y];
  if (!d) return (sets[y] = null);
  const off = new Set(), work = new Set(d.work);
  for (const [a, b] of d.off) {
    const [am, ad] = a.split('-').map(Number), [bm, bd] = b.split('-').map(Number);
    for (let t = new Date(Date.UTC(y, am - 1, ad)); t <= new Date(Date.UTC(y, bm - 1, bd)); t.setUTCDate(t.getUTCDate() + 1)) off.add(`${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`);
  }
  return (sets[y] = { off, work });
}

/** 某天是不是工作日。参数是日历上的年月日（m 从 1 起），与时区无关 */
export function isWorkday(y, m, d) {
  const s = yearSets(y), k = `${pad(m)}-${pad(d)}`;
  if (s && s.work.has(k)) return true;
  if (s && s.off.has(k)) return false;
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd >= 1 && wd <= 5;
}

/** 日历上的小标记：'off' 法定节假日（休）/ 'work' 调休上班（班）/ null 普通日子（或那一年没有数据） */
export function holidayMark(y, m, d) {
  const s = yearSets(y), k = `${pad(m)}-${pad(d)}`;
  return !s ? null : s.work.has(k) ? 'work' : s.off.has(k) ? 'off' : null;
}

/** 节假日表覆盖到哪一年 */
export const holidayYears = () => Object.keys(DATA).map(Number).sort();
export const lastHolidayYear = () => Math.max(...holidayYears());
