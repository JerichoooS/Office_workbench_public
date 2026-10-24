// pwa.js — 「添加到主屏幕」与推送订阅
// iPhone 的网页推送要求：iOS 16.4+；必须从主屏幕图标打开（standalone）；用户点按钮后才能请求权限。

import { table, run } from '../data/db.js';
import { ago } from './dates.js';

export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

let reg = null;
export async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  try { reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' }); } catch (e) { console.warn('sw register failed', e.message); }
  return reg;
}

/** 当前状态：unsupported / need-home-screen / denied / off / on / server-off */
export async function pushState() {
  if (isIOS() && !isStandalone()) return 'need-home-screen';
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try { if ((await fetch('/api/push/key')).status === 503) return 'server-off'; } catch (_) { /* 网络问题按 off 处理 */ }
  const r = reg || await navigator.serviceWorker.getRegistration('/');
  const sub = r && await r.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}

const fromB64u = s => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(b, c => c.charCodeAt(0)); };

async function serverKey() {
  const res = await fetch('/api/push/key');
  if (res.status === 503) { const e = new Error('服务器还没有启用推送（P3 部署后开放）'); e.code = 'server-off'; throw e; }
  if (!res.ok) throw new Error('取推送公钥失败（' + res.status + '）');
  return (await res.json()).publicKey;
}

/** 开启：请求权限 → 订阅 → 存到 push_subscriptions（每台设备一行） */
export async function enablePush() {
  const r = reg || await registerSW();
  if (!r) throw new Error('这个浏览器不支持后台通知');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied' ? '通知权限被拒绝，请在系统设置里允许「工作台」发送通知' : '没有获得通知权限');
  const key = await serverKey();
  let sub = await r.pushManager.getSubscription();
  if (!sub) sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(key) });
  const j = sub.toJSON();
  const existing = await run(table('push_subscriptions').select('id').eq('endpoint', j.endpoint).maybeSingle());
  const row = { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent.slice(0, 200) };
  if (existing) await run(table('push_subscriptions').update(row).eq('id', existing.id));
  else await run(table('push_subscriptions').insert(row));
  return sub;
}

/**
 * 这台设备的订阅还在不在服务器上（推送服务退回「订阅已失效」时，服务器会删掉那一行）。
 * 返回 true 在 / false 不在（需要重新开启）/ null 这台设备没订阅或查不了
 */
export async function subscriptionOnServer() {
  if (!pushSupported()) return null;
  const r = reg || await navigator.serviceWorker.getRegistration('/');
  const sub = r && await r.pushManager.getSubscription();
  if (!sub) return null;
  const rows = await run(table('push_subscriptions').select('id').eq('endpoint', sub.endpoint).limit(1));
  return rows.length > 0;
}

/** 重新开启：旧订阅已经失效，先在本机退订，再走一遍「开启通知」（拿到新的订阅并存到服务器） */
export async function reEnablePush() {
  const r = reg || await navigator.serviceWorker.getRegistration('/');
  const old = r && await r.pushManager.getSubscription();
  if (old) { try { await old.unsubscribe(); } catch (_) { /* 退订失败不要紧，下面会重新订阅 */ } }
  return enablePush();
}

/** 服务器上提醒服务的状态（GET /api/push/status）：{ push, lastTick, lastOk, startedAt… }；取不到返回 null */
export async function serviceStatus() {
  try { const res = await fetch('/api/push/status', { cache: 'no-store' }); return res.ok ? await res.json() : null; } catch (_) { return null; }
}

export async function disablePush() {
  const r = reg || await navigator.serviceWorker.getRegistration('/');
  const sub = r && await r.pushManager.getSubscription();
  if (!sub) return;
  await run(table('push_subscriptions').delete().eq('endpoint', sub.endpoint));
  await sub.unsubscribe();
}

export async function sendTestPush() {
  const r = reg || await navigator.serviceWorker.getRegistration('/');
  const sub = r && await r.pushManager.getSubscription();
  if (!sub) throw new Error('这台设备还没开启通知');
  const res = await fetch('/api/push/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON() }) });
  if (!res.ok) throw new Error('发送失败（' + res.status + '）');
}

/** 已开启通知的设备数（设置页显示） */
export async function deviceCount() {
  const rows = await run(table('push_subscriptions').select('id'));
  return rows.length;
}

/**
 * 方案 C：服务器没有口令文件时，由管理员（应用主人）登录后把口令交给服务器。
 * 非管理员调用 wb_admin_server_token() 只会拿到 NULL，什么也不做。本地模拟模式跳过。
 */
export async function handOverServerToken() {
  if (window.WBBoot.mock) return 'mock';
  try {
    const st = await (await fetch('/api/push/status')).json();
    if (st.push !== 'locked') return st.push;
    const res = await window.cloud.database.rpc('wb_admin_server_token');
    if (res.error || !res.data) return 'locked';
    const r = await fetch('/api/push/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: res.data }) });
    return r.ok ? 'on' : 'locked';
  } catch (_) { return 'unknown'; }
}

/**
 * 服务器上的提醒服务（GET /api/push/status）说成人话。字段：push 'on'|'locked'|'waiting'|'off'；
 * lastTick 上一轮跑完的时间（每分钟一轮）；lastOk 上一轮没出数据库错误的时间；startedAt 服务器启动时间（都可能没有）。
 * 返回 { text, chip, cls }；旧版服务器（没有 lastTick 字段）且推送正常时返回 null（不显示这一行）
 */
export function serviceLine(st, now = Date.now()) {
  if (!st) return { text: '暂时查不到提醒服务的状态（网络不稳定），稍后再看。', chip: '', cls: '' };
  const mins = iso => (iso ? (now - Date.parse(iso)) / 60000 : Infinity);
  if (st.push === 'off') return { text: '这台服务器没有开启提醒推送（本机调试时是这样）。正式网址上的工作台照常提醒。', chip: '没开启', cls: '' };
  if (st.push !== 'on') return { text: '提醒服务暂停中：服务器刚重启（例如重新部署后），管理员打开一次工作台就会恢复；6 小时内错过的提醒会补发。', chip: '暂停', cls: 'warn' };
  if (!('lastTick' in st)) return null;
  const ok = mins(st.lastOk), tick = mins(st.lastTick);
  if (ok <= 3) return { text: `提醒服务正常 · ${ok < 1 ? '刚刚' : Math.floor(ok) + ' 分钟前'}检查过`, chip: '正常', cls: 'ok' };
  if (tick <= 3) return { text: '提醒服务在运行，但连不上数据库，正在重试。到点的提醒可能会晚一点发出。', chip: '在重试', cls: 'warn' };
  if (!st.lastTick && (!st.startedAt || mins(st.startedAt) <= 3)) return { text: '提醒服务刚启动，1～2 分钟后开始检查。', chip: '启动中', cls: '' };
  return { text: `提醒服务好像停了${st.lastTick ? `，上次检查是 ${ago(st.lastTick)}` : ''}。重新部署或服务器维护后一般会自动恢复；一直这样请告诉管理员。`, chip: '停了', cls: 'bad' };
}
