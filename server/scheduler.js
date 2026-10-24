/**
 * scheduler.js — 每分钟一次的推送调度（无状态、幂等）
 *
 * 设计要点（服务可能被平台重启，内存/磁盘都不可靠）：
 *   1. 所有状态在数据库：提醒的 sent_at、早晚报的 last_*_sent。
 *   2. 「先认领再发送」：store.claimDueReminders() 在数据库里一次性把到期提醒标为已发并返回，
 *      两个实例同时跑或重启后重跑，也不会重复推送（发送途中进程退出的那一条会漏发，不会重复轰炸）。
 *      推送服务明确告诉我们没送到的，按第 5 条重试。
 *   3. 补发窗口：重启期间错过的提醒，6 小时内的补发；更早的只标记、不推送（避免一开机狂响）。
 *      早晚报超过设定时间 3 小时不再补发（见 notify.js digestDue）。
 *   4. 催办发出后，按项目进度排下一次（core/schedule.js），直到待办离开「等待他人」。
 *   5. 发送失败重试（005，用户确认：「最多 3 次；宁可偶尔重复收到一次」）：
 *      一条提醒有订阅、但一台设备都没送到 → store.reminderFailed(id, retry)。
 *        - 有设备是临时失败（推送服务报错、超时、断网）→ retry = true：放回队列，2/4/6 分钟后再发，最多 3 次，用完记「没送达」；
 *        - 催办不重试（认领时下一次催办已经排上了）→ retry = false，直接记「没送达」，应用里能看到；
 *        - 所有设备都失效（404/410，订阅已删）→ retry = false，记「没送达」。
 *      用户没开通知（零个订阅）不算失败，什么都不做。
 *   6. 每日云端快照（005）：每轮顺带调用 store.dailySnapshots()，最多 10 分钟一次（数据库里每人每天只存一份，重启后重调也没关系）。
 *   7. 数据库还没执行 005 时，新函数不存在（PGRST202 / 42883）：只记一行日志，提醒照旧发送；快照暂停 6 小时再试。
 *   8. 任何一步数据库出错只影响这一条/这一步，不中断本轮其余的提醒、早晚报和快照。
 *   9. 心跳（只在内存，重启清零）：最近一轮跑完的时间、最近一轮没出错的时间、最近一次快照成功的时间，
 *      由 GET /api/push/status 交给设置页显示「提醒服务正常 · 1 分钟前」。不含口令、不含用户数据。
 *
 * store 是数据访问适配器：线上为 server/store-db.js（调用 002_push.sql / 005_phase2.sql 的口令函数），测试用内存版。
 * 接口：
 *   claimDueReminders(now, catchUpMs) → [{ reminder, todo, task, waitingName, timezone, subs, stale }]
 *   scheduleNudge(reminder, todo, fireAt)
 *   listDigestCandidates(now) → [{ settings, todos, subs }]
 *   markDigestSent(ownerId, kind, dayKey) → boolean（false = 已被别人标记，跳过）
 *   removeSubscription(endpoint)
 *   reminderFailed(id, retry) → 'retry' | 'failed' | 'gone'（005）
 *   dailySnapshots() → 本次新存了几份（005）
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { sendPush } = require('./webpush');

const CATCH_UP_MS = 6 * 3600 * 1000;
const SNAPSHOT_EVERY_MS = 10 * 60 * 1000;          // 快照最多 10 分钟调一次
const MISSING_BACKOFF_MS = 6 * 3600 * 1000;        // 快照函数不存在（没执行 005）：6 小时后再试
const MISSING_CODES = ['PGRST202', '42883', '404']; // 与前端 data/features.js 相同：函数不存在 = 数据库还没执行 005

let shared = null;
async function lib() {
  if (!shared) {
    const base = path.join(__dirname, '..', 'public', 'app', 'core');
    const [notify, schedule] = await Promise.all([import(pathToFileURL(path.join(base, 'notify.js')).href), import(pathToFileURL(path.join(base, 'schedule.js')).href)]);
    shared = { ...notify, ...schedule };
  }
  return shared;
}

/** 数据库函数不存在（还没执行对应的迁移） */
const missingRpc = e => !!e && (MISSING_CODES.includes(String(e.code)) || e.status === 404);
/** 日志里的错误说明：只取一行、截短 */
const errText = e => String((e && e.message) || e || '未知错误').split('\n')[0].slice(0, 160);

/** 运行状态（只在内存）。tick() 默认写模块里这一份；测试可以传自己的一份 */
function newHealth() {
  return { lastTick: null, lastOk: null, lastError: null, lastErrorAt: null, snapshotAt: null, snapshotTriedAt: 0, snapshotPausedUntil: 0, warned: new Set() };
}
const health = newHealth();

/** 同一件事只记一行日志（例如没执行 005），恢复后清掉，再出现时会重新记 */
function warnOnce(h, key, log, ...msg) {
  if (h.warned.has(key)) return;
  h.warned.add(key);
  log(...msg);
}

/** 设置页用的心跳：只有三个时间，不含错误内容（报错文字里可能带用户数据） */
function heartbeat(h = health) {
  const iso = d => (d ? d.toISOString() : null);
  return { lastTick: iso(h.lastTick), lastOk: iso(h.lastOk), snapshotAt: iso(h.snapshotAt) };
}

/** 发给一个用户的所有设备。返回 { ok 送达, failed 临时失败（非 2xx 或出错）, gone 订阅已失效（404/410，已删） } */
async function deliver(store, subs, message, vapid, subject, log) {
  const out = { ok: 0, failed: 0, gone: 0 };
  for (const sub of subs || []) {
    let r;
    try {
      // urgency=high：对应苹果推送的高优先级，手机待机/省电时也立即送达（normal 可能被系统攒着晚发）
      r = await sendPush({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, message, { vapid, subject, urgency: 'high', ttl: 6 * 3600, topic: (message.tag || '').slice(0, 32).replace(/[^A-Za-z0-9_-]/g, '') || undefined });
    } catch (e) { out.failed++; log('推送出错', errText(e)); continue; }
    if (r.gone) {
      out.gone++;
      try { await store.removeSubscription(sub.endpoint); } catch (e) { log('删除失效订阅出错', errText(e)); }
    } else if (r.status < 300) out.ok++;
    else { out.failed++; log('推送服务返回', r.status); }
  }
  return out;
}

const FAILED_TEXT = { retry: '稍后重试', failed: '记为没送达', gone: '提醒已不存在' };

/** 跑一轮。返回统计，便于日志与测试。不会抛错：出错的那一步记进 stats.errors 和心跳，其余照常 */
async function tick(store, { vapid, subject, now = new Date(), log = () => {}, state = health } = {}) {
  const stats = { reminders: 0, stale: 0, digests: 0, pushes: 0, failed: 0, errors: 0 };
  let lastError = null;
  const oops = (what, e) => { stats.errors++; lastError = `${what}：${errText(e)}`; log(what, errText(e)); };

  try {
    const L = await lib();

    // ---- 到期提醒 ----
    let due = [];
    try { due = (await store.claimDueReminders(now, CATCH_UP_MS)) || []; } catch (e) { oops('认领提醒出错', e); }
    for (const item of due) {
      try {
        const { reminder, todo, task, timezone } = item;
        if (!todo) continue;
        if (reminder.kind === 'nudge' && todo.status === 'waiting') {
          try { await store.scheduleNudge(reminder, todo, L.nextNudgeAt(task, now, now, timezone || 'Asia/Shanghai')); }
          catch (e) { oops('催办续排出错', e); }
        }
        if (item.stale || todo.status === 'done' || (reminder.kind === 'nudge' && todo.status !== 'waiting')) { stats.stale++; continue; }
        const msg = L.reminderMessage({ reminder, todo, task, waitingName: item.waitingName, now, tz: timezone });
        const d = await deliver(store, item.subs, msg, vapid, subject, log);
        stats.pushes += d.ok;
        stats.reminders++;
        // 有订阅却一台都没送到 = 没送达；没有订阅（用户没开通知）不算
        if (!(item.subs || []).length || d.ok > 0) continue;
        stats.failed++;
        const retry = d.failed > 0 && reminder.kind !== 'nudge';
        try {
          const res = await store.reminderFailed(reminder.id, retry);
          state.warned.delete('reminderFailed');
          log('提醒没送达', `#${reminder.id}（${reminder.kind}，已重试 ${reminder.attempts || 0} 次）→ ${FAILED_TEXT[res] || res}`);
        } catch (e) {
          if (missingRpc(e)) warnOnce(state, 'reminderFailed', log, '数据库还没执行 005：提醒发送失败不会重试，也不会记「没送达」（提醒照常发送）');
          else oops('记录提醒没送达出错', e);
        }
      } catch (e) { oops('处理提醒出错', e); }
    }

    // ---- 早晚报 ----
    let candidates = [];
    try { candidates = (await store.listDigestCandidates(now)) || []; } catch (e) { oops('读取早晚报对象出错', e); }
    for (const c of candidates) {
      for (const kind of ['morning', 'evening']) {
        try {
          if (!L.digestDue(c.settings, kind, now)) continue;
          const tz = c.settings.timezone || 'Asia/Shanghai';
          if (!(await store.markDigestSent(c.settings.owner_id, kind, L.zoned(now, tz).key))) continue;
          const msg = L.digestMessage(kind, { todos: c.todos, now, tz });
          stats.pushes += (await deliver(store, c.subs, msg, vapid, subject, log)).ok;
          stats.digests++;
        } catch (e) { oops('早晚报出错', e); }
      }
    }
  } catch (e) { oops('本轮出错', e); }

  // ---- 每日云端快照：放在最后，慢了也不耽误提醒；出错不算本轮出错 ----
  await snapshot(store, now, log, state);

  const at = new Date();
  state.lastTick = at;
  if (stats.errors) { state.lastError = lastError; state.lastErrorAt = at; } else state.lastOk = at;
  return stats;
}

/** 每日快照：最多 10 分钟调一次（按本轮的 now 计时）；函数不存在时暂停 6 小时 */
async function snapshot(store, now, log, state) {
  if (typeof store.dailySnapshots !== 'function') return;
  const t = +now;
  if (t < state.snapshotPausedUntil) return;
  if (state.snapshotTriedAt && Math.abs(t - state.snapshotTriedAt) < SNAPSHOT_EVERY_MS) return;
  state.snapshotTriedAt = t;
  try {
    const n = await store.dailySnapshots();
    state.snapshotAt = new Date();
    state.warned.delete('dailySnapshots');
    if (n > 0) log('云端快照', `新存 ${n} 份`);
  } catch (e) {
    if (missingRpc(e)) {
      state.snapshotPausedUntil = t + MISSING_BACKOFF_MS;
      warnOnce(state, 'dailySnapshots', log, '数据库还没执行 005：每日云端快照暂停，6 小时后再试');
    } else log('云端快照出错', errText(e));
  }
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
        if (s.reminders || s.digests || s.stale || s.failed || s.errors) log('本轮', JSON.stringify(s));
      }
    } catch (e) { log('本轮出错', errText(e)); }
    finally { running = false; }
  };
  setTimeout(() => { run(); setInterval(run, 60 * 1000); }, 60000 - (Date.now() % 60000) + 2000);
}

module.exports = { tick, start, heartbeat, newHealth, health, missingRpc, CATCH_UP_MS, SNAPSHOT_EVERY_MS, MISSING_BACKOFF_MS };
