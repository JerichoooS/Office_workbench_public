/**
 * store-db.js — 服务器访问云数据库的适配器（scheduler.js 的 store）
 * 做法：在 Node 里加载与前端相同的 WorkBuddy SDK（public/vendor），以 anon 身份调用
 *       db/migrations/002_push.sql 中带口令校验的 SECURITY DEFINER 函数。服务器不持有任何数据库管理密钥。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { generateVapidKeys } = require('./webpush');

const ROOT = path.join(__dirname, '..');

/** 读取 public/config.js 里的公开配置（与前端同一份，避免重复维护） */
function publicConfig() {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public', 'config.js'), 'utf8'), ctx);
  return ctx.window.WB_PUBLIC_CONFIG;
}

let client = null;
function cloud() {
  if (client) return client;
  const code = fs.readFileSync(path.join(ROOT, 'public', 'vendor', 'workbuddy-cloud-sdk.global.js'), 'utf8');
  const ctx = { console, fetch, Headers, Request, Response, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout, crypto: globalThis.crypto, atob, btoa };
  ctx.globalThis = ctx; ctx.self = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(code + '\n;globalThis.WorkBuddyCloud = WorkBuddyCloud;', ctx);
  const mem = new Map();
  const storage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: k => mem.delete(k) };
  client = ctx.WorkBuddyCloud.createWorkBuddyCloud({ ...publicConfig(), storage });
  return client;
}

/** rpcImpl 仅供测试注入（例如接到本地 Postgres），线上用 SDK */
function createDbStore(token, rpcImpl) {
  async function rpc(name, params = {}) {
    const res = rpcImpl ? await rpcImpl(name, { p_token: token, ...params }) : await cloud().database.rpc(name, { p_token: token, ...params });
    // code / status 原样带出：调度据此判断「函数不存在 = 数据库还没执行 005」（见 scheduler.js missingRpc）
    if (res.error) { const e = new Error(`${name}: ${res.error.message || res.error.code}`); e.code = res.error.code; e.status = res.status || res.error.status; throw e; }
    return res.data;
  }

  return {
    /** 推送签名密钥：库里没有就生成一对写进去（只会成功一次），再读回 */
    async vapid() {
      let v = await rpc('wb_server_vapid');
      if (!v) { const k = generateVapidKeys(); await rpc('wb_server_init_vapid', { p_public: k.publicKey, p_private: k.privateKey }); v = await rpc('wb_server_vapid'); }
      return v;
    },
    async claimDueReminders(now, catchUpMs) {
      const rows = (await rpc('wb_claim_due', { p_limit: 200 })) || [];
      // 重试中的（attempts > 0）不算过期：它第一次没送到时还在补发窗口内，不能因为重试拖过了 6 小时就悄悄丢掉
      return rows.map(r => ({ ...r, stale: !(r.reminder.attempts > 0) && now - new Date(r.reminder.fire_at) > catchUpMs }));
    },
    async scheduleNudge(reminder, todo, fireAt) { return rpc('wb_schedule_nudge', { p_todo_id: todo.id, p_fire_at: new Date(fireAt).toISOString() }); },
    async listDigestCandidates() { return (await rpc('wb_digest_candidates')) || []; },
    async markDigestSent(owner, kind, day) { return !!(await rpc('wb_mark_digest', { p_owner: owner, p_kind: kind, p_day: day })); },
    async removeSubscription(endpoint) { return rpc('wb_remove_subscription', { p_endpoint: endpoint }); },
    // 以下两个函数在 005_phase2.sql 里；没执行 005 时会报 PGRST202 / 42883，由 scheduler.js 记一行日志后跳过，不影响发提醒
    /** 一条提醒没送达：retry = true 放回队列 2/4/6 分钟后重发（最多 3 次），否则记为没送达。返回 'retry' / 'failed' / 'gone' */
    async reminderFailed(id, retry) { return rpc('wb_reminder_failed', { p_id: id, p_retry: !!retry }); },
    /** 每日云端快照：每人每天一份（已有就跳过），只留 14 天。返回本次新存了几份 */
    async dailySnapshots() { return rpc('wb_daily_snapshots'); },
  };
}

module.exports = { createDbStore, publicConfig };
