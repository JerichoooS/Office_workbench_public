// 首页提示卡 · 提醒送达（同一时间只出一张，见 home-notice.js）
//   1. 第二阶段：最近 3 天有提醒重试 3 次仍没送达（reminders.failed_at）→「有 N 条提醒没送达」，列出标题和原定时间
//   2. 任何阶段：有提醒过了时间 10 分钟还没发出（sent_at 为空）→ 提醒服务可能没在运行
// 「知道了」：这几条记在本机（localStorage wb-delivery-ack），不再提示；以后有新的再出。「去设置看看」→ 设置 › 通知与提醒（那里有提醒服务的状态）。
// 首页每次刷新都会重挂提示卡：查询结果缓存 1 分钟，避免每次刷新多查两次。

import { esc } from '../../core/dom.js';
import { dueLabel } from '../../core/dates.js';
import { failedReminders, staleReminders } from '../../data/repos/delivery.js';
import { openTodo } from '../todo-detail.js';

const ACK = 'wb-delivery-ack';
const TTL = 60000;
let cache = null;

const acked = () => { try { return new Set(JSON.parse(localStorage.getItem(ACK)) || []); } catch (_) { return new Set(); } };
function ack(keys) {
  const all = [...acked(), ...keys].slice(-200);   // 只留最近的，免得越存越多
  try { localStorage.setItem(ACK, JSON.stringify(all)); } catch (_) { /* 无痕模式：本次不再显示即可 */ }
}

async function load() {
  if (cache && Date.now() - cache.at < TTL) return cache;
  const [failed, stale] = await Promise.all([failedReminders(3), staleReminders(10)]);
  cache = { at: Date.now(), failed, stale };
  return cache;
}

const lines = rows => `<ul class="notice-list">${rows.slice(0, 3).map(r => `<li><button type="button" class="notice-link" data-open="${esc(r.todo_id)}">${esc(r.todo.title)}</button><span class="num">${esc(dueLabel(r.fire_at, false))}</span></li>`).join('')}${rows.length > 3 ? `<li class="hint">还有 ${rows.length - 3} 条</li>` : ''}</ul>`;

function card(rows, keys, title, desc) {
  return {
    html: `<div class="notice-t warn-mark">${title}</div>${lines(rows)}<div class="notice-d">${desc}</div>
      <div class="notice-acts"><button type="button" class="btn small row-act" data-ack>知道了</button><a class="btn small row-act" href="#/settings/notify">去设置看看</a></div>`,
    bind(el, refresh) {
      el.addEventListener('click', e => {
        const o = e.target.closest('[data-open]');
        if (o) { e.stopPropagation(); openTodo(o.dataset.open); return; }
        if (e.target.closest('[data-ack]')) { e.stopPropagation(); ack(keys); refresh(); }
      });
    },
  };
}

export async function notice() {
  const { failed, stale } = await load();
  const seen = acked();
  const f = failed.filter(r => !seen.has('f:' + r.id));
  if (f.length) {
    return card(f, f.map(r => 'f:' + r.id), `有 <span class="num">${f.length}</span> 条提醒没送达`,
      '服务器试了 3 次都没推送成功。可能是这台设备关掉了通知，或者手机的推送服务一时连不上。');
  }
  const s = stale.filter(r => !seen.has('s:' + r.id));
  if (s.length) {
    return card(s, s.map(r => 's:' + r.id), `有 <span class="num">${s.length}</span> 条提醒过了时间还没发出`,
      '提醒服务可能没在运行。服务器重启后，管理员打开一次工作台就能恢复；6 小时内错过的提醒会补发。');
  }
  return null;
}
