// pwa.js — 「添加到主屏幕」与推送订阅
// iPhone 的网页推送要求：iOS 16.4+；必须从主屏幕图标打开（standalone）；用户点按钮后才能请求权限。

import { table, run } from '../data/db.js';

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
