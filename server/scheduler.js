/**
 * scheduler.js — 每分钟一次的推送调度（无状态、幂等）
 *
 * 设计要点（服务可能被平台重启，内存/磁盘都不可靠）：
 *   1. 所有状态在数据库：提醒的 sent_at、早晚报的 last_*_sent。
 *   2. 「先认领再发送」：store.claimDueReminders() 在数据库里一次性把到期提醒标为已发并返回，
 *      两个实例同时跑或重启后重跑，也不会重复推送（宁可漏发一条，不重复轰炸）。
 *   3. 补发窗口：重启期间错过的提醒，6 小时内的补发；更早的只标记、不推送（避免一开机狂响）。
 *      早晚报超过设定时间 3 小时不再补发（见 notify.js digestDue）。
 *   4. 催办发出后，按项目进度排下一次（core/schedule.js），直到待办离开「等待他人」。
 *
 * store 是数据访问适配器：线上为 server/store-db.js（调用 002_push.sql 的口令函数），测试用内存版。
 * 接口：
 *   claimDueReminders(now, catchUpMs) → [{ reminder, todo, task, waitingName, timezone, subs, stale }]
 *   scheduleNudge(reminder, todo, fireAt)
 *   listDigestCandidates(now) → [{ settings, todos, subs }]
 *   markDigestSent(ownerId, kind, dayKey) → boolean（false = 已被别人标记，跳过）
 *   removeSubscription(endpoint)
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { sendPush } = require('./webpush');

const CATCH_UP_MS = 6 * 3600 * 1000;
let shared = null;
async function lib() {
  if (!shared) {
    const base = path.join(__dirname, '..', 'public', 'app', 'core');
    const [notify, schedule] = await Promise.all([import(pathToFileURL(path.join(base, 'notify.js')).href), import(pathToFileURL(path.join(base, 'schedule.js')).href)]);
    shared = { ...notify, ...schedule };
  }
  return shared;
}

async function deliver(store, subs, message, vapid, subject, log) {
  let ok = 0;
  for (const sub of subs || []) {
    try {
      const r = await sendPush({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, message, { vapid, subject, topic: (message.tag || '').slice(0, 32).replace(/[^A-Za-z0-9_-]/g, '') || undefined });
      if (r.gone) await store.removeSubscription(sub.endpoint);
      else if (r.status < 300) ok++;
      else log('push status', r.status);
    } catch (e) { log('push error', e.message); }
  }
  return ok;
}

/** 跑一轮。返回统计，便于日志与测试 */
async function tick(store, { vapid, subject, now = new Date(), log = () => {} } = {}) {
  const L = await lib();
  const stats = { reminders: 0, stale: 0, digests: 0, pushes: 0 };

  const due = await store.claimDueReminders(now, CATCH_UP_MS);
  for (const item of due) {
    const { reminder, todo, task, timezone } = item;
    if (!todo) continue;
    if (reminder.kind === 'nudge' && todo.status === 'waiting') {
      await store.scheduleNudge(reminder, todo, L.nextNudgeAt(task, now, now, timezone || 'Asia/Shanghai'));
    }
    if (item.stale || todo.status === 'done' || (reminder.kind === 'nudge' && todo.status !== 'waiting')) { stats.stale++; continue; }
    const msg = L.reminderMessage({ reminder, todo, task, waitingName: item.waitingName, now, tz: timezone });
    stats.pushes += await deliver(store, item.subs, msg, vapid, subject, log);
    stats.reminders++;
  }

  const candidates = await store.listDigestCandidates(now);
  for (const c of candidates) {
    for (const kind of ['morning', 'evening']) {
      if (!L.digestDue(c.settings, kind, now)) continue;
      const tz = c.settings.timezone || 'Asia/Shanghai';
      if (!(await store.markDigestSent(c.settings.owner_id, kind, L.zoned(now, tz).key))) continue;
      const msg = L.digestMessage(kind, { todos: c.todos, now, tz });
      stats.pushes += await deliver(store, c.subs, msg, vapid, subject, log);
      stats.digests++;
    }
  }
  return stats;
}

/** 启动定时器：对齐到整分钟，每 60 秒一轮；一轮没跑完不会叠加。getContext() 返回 { store, vapid } 或 null（未启用） */
function start(getContext, { subject, log = () => {} } = {}) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const c = await getContext();
      if (c) {
        const s = await tick(c.store, { vapid: c.vapid, subject, log });
        if (s.reminders || s.digests || s.stale) log('tick', JSON.stringify(s));
      }
    } catch (e) { log('tick failed', e.message); }
    finally { running = false; }
  };
  setTimeout(() => { run(); setInterval(run, 60 * 1000); }, 60000 - (Date.now() % 60000) + 2000);
}

module.exports = { tick, start, CATCH_UP_MS };
