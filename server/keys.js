/**
 * keys.js — 服务器口令与推送密钥的来源
 *
 * 服务器口令（证明「我是服务器」，用于调用 002_push.sql 里的函数）：
 *   - 存放方案由用户选择（见 docs/开发规范.md §8）。本文件按顺序尝试：
 *       1) server/server-token.txt（方案 B：放在私有仓库，不在 public/ 下，网页访问不到）
 *       2) 运行时注入 setToken()（方案 C 预留：登录后的应用交给服务器，只存内存）
 *   - 都没有 → 推送不启用，其他功能不受影响。
 * 推送签名密钥（VAPID）：存数据库 server_config（前端读不到）；首次启动自动生成。
 * 本地开发（HOST=127.0.0.1）：没有口令时用 server/.dev-keys.json 里的本地密钥，只用于「发测试通知」。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { generateVapidKeys } = require('./webpush');
const { createDbStore, publicConfig } = require('./store-db');

const TOKEN_FILE = path.join(__dirname, 'server-token.txt');
const DEV_FILE = path.join(__dirname, '.dev-keys.json');
const isLocal = () => /^(127\.0\.0\.1|localhost|::1)$/.test(process.env.HOST || '');

// VAPID 联系方式：自动取本部署的站点地址（public/config.js 的 endpoint），不写死、不用个人邮箱
let SUBJECT = 'https://workbuddy.host';
try { SUBJECT = new URL(publicConfig().endpoint).origin; } catch (_) { /* 未配置时用默认值 */ }

let token = null;
try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null; } catch (_) { /* 未配置 */ }

let ctx = null;          // { store, vapid }
let failedAt = 0;

/** 返回 { store, vapid }；未配置或数据库未就绪时返回 null（每 5 分钟重试一次） */
async function getContext() {
  if (ctx) return ctx;
  if (!token || Date.now() - failedAt < 5 * 60 * 1000) return null;
  try {
    const store = createDbStore(token);
    const vapid = await store.vapid();
    ctx = { store, vapid };
    console.log('[push] enabled');
    return ctx;
  } catch (e) {
    failedAt = Date.now();
    console.log('[push] not ready:', e.message);
    return null;
  }
}

/** 方案 C：管理员登录后，应用把口令交给服务器。校验通过（能用它从数据库取到推送密钥）才接受，只存内存 */
async function unlock(t) {
  if (ctx) return true;
  if (typeof t !== 'string' || !/^[a-f0-9]{64}$/.test(t)) return false;
  try {
    const store = createDbStore(t);
    const vapid = await store.vapid();
    token = t; ctx = { store, vapid }; failedAt = 0;
    console.log('[push] enabled (token handed over by admin)');
    return true;
  } catch (e) { return false; }
}

/** 'on' 推送运行中；'locked' 没有口令（方案 C 等管理员打开应用）；'waiting' 有口令但数据库还没就绪 */
async function status() {
  if (ctx) return 'on';
  if (!token) return 'locked';
  return (await getContext()) ? 'on' : 'waiting';
}

/** 推送公钥（给前端订阅用）与测试推送用的密钥 */
async function getVapid() {
  const c = await getContext();
  if (c) return c.vapid;
  if (isLocal()) {
    try { return JSON.parse(fs.readFileSync(DEV_FILE, 'utf8')); }
    catch (_) { const k = generateVapidKeys(); fs.writeFileSync(DEV_FILE, JSON.stringify(k, null, 2)); return k; }
  }
  return null;
}

module.exports = { getContext, getVapid, unlock, status, SUBJECT };
