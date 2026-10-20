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
    if (res.error) { const e = new Error(`${name}: ${res.error.message || res.error.code}`); e.code = res.error.code; throw e; }
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
      return rows.map(r => ({ ...r, stale: now - new Date(r.reminder.fire_at) > catchUpMs }));
    },
    async scheduleNudge(reminder, todo, fireAt) { return rpc('wb_schedule_nudge', { p_todo_id: todo.id, p_fire_at: new Date(fireAt).toISOString() }); },
    async listDigestCandidates() { return (await rpc('wb_digest_candidates')) || []; },
    async markDigestSent(owner, kind, day) { return !!(await rpc('wb_mark_digest', { p_owner: owner, p_kind: kind, p_day: day })); },
    async removeSubscription(endpoint) { return rpc('wb_remove_subscription', { p_endpoint: endpoint }); },
  };
}

module.exports = { createDbStore, publicConfig };
