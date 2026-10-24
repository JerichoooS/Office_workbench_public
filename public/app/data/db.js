// db.js — 数据库调用的唯一出口：执行查询、统一错误提示、广播数据变化、同步状态
// 视图层不要直接写 cloud.database；一律通过 data/repos/*.js。
//
// 弱网（地下室、电梯里、人多的场馆）要点：
//   - 登录凭证刷新因断网失败时，SDK 会不带登录信息继续查询，云库按权限规则返回空列表，看起来像「数据全没了」。
//     所以每次查询前先确认拿得到凭证；拿不到但本机还存着登录信息 = 网络问题：不发请求、保持当前画面、标成「离线」。
//   - 15 秒没有回应按超时处理；网络错误一律换成中文说明。
//   - 每次成功/失败更新同步状态（首页日期旁、电脑侧栏底部的小圆点）。

import { toast } from '../core/dom.js';

export const table = name => window.cloud.database.from(name);

const MESSAGES = {
  '42P01': '数据表尚未初始化，请让 WorkBuddy 执行 db/migrations 下的建表脚本',
  '42501': '没有权限执行此操作',
  '23505': '记录已存在',
  '23503': '关联的数据不存在或已删除',
  PGRST301: '登录已过期，请刷新页面',
};
const TIMEOUT_MS = 15000;
const NET = /failed to fetch|load failed|networkerror|network request failed|fetch failed|request failed before a response|timeout|aborted/i;
const OFFLINE_MSG = '网络不稳定，这次没有连上云端。页面保留当前内容，网络恢复后会自动刷新。';
// 写入失败要说清楚「没保存」：第一阶段还没有离线排队，用户得在网络恢复后再操作一次
const OFFLINE_WRITE_MSG = '网络不稳定，刚才的修改没有保存。请等网络恢复后再操作一次。';
// 查询构造器是写操作吗（SDK 的构造器带 HTTP method；本地模拟库带 op）
const isWrite = b => !!b && ((b.method && !/^(GET|HEAD)$/i.test(b.method)) || (b.op && b.op !== 'select'));

// ---------- 同步状态 ----------
const sync = { state: 'ok', at: null };   // ok 已同步 / offline 网络有问题 / error 保存失败
const syncListeners = new Set();
export const syncState = () => ({ ...sync });
export const onSync = fn => { syncListeners.add(fn); return () => syncListeners.delete(fn); };
let retryTimer = null;
function setSync(state) {
  const was = sync.state;
  sync.state = state; if (state === 'ok') sync.at = new Date();
  // 网络有问题期间每 30 秒（页面在前台时）重新拉一次；恢复后停止
  if (state === 'offline' && !retryTimer) retryTimer = setInterval(() => { if (document.visibilityState === 'visible') changed('retry'); }, 30000);
  if (state !== 'offline' && retryTimer) { clearInterval(retryTimer); retryTimer = null; }
  if (was !== state || state === 'ok') syncListeners.forEach(fn => { try { fn(syncState()); } catch (e) { console.error(e); } });
}
try {
  window.addEventListener('offline', () => setSync('offline'));
  window.addEventListener('online', () => { if (sync.state === 'offline') changed('online'); });   // 网络回来：重新拉一次，成功即恢复「已同步」
} catch (_) { /* 非浏览器环境 */ }

/** 本机是否还存着登录信息（SDK 刷新失败但没清掉 = 网络问题，不是退出登录） */
export function hasStoredSession() {
  try { const c = window.WB_PUBLIC_CONFIG; return !!(c && localStorage.getItem('workbuddy-cloud.session.' + c.publishableKey)); } catch (_) { return false; }
}

let lastNetToast = 0;
function fail(msg, code, { quiet = false } = {}) {
  if (!quiet) toast(msg);
  const err = new Error(msg); err.code = code; err.handled = true;
  return err;
}

/** 网络类失败：读的提示 20 秒内只弹一次；写的每次都说清楚没保存 */
function offline(builder, msg, { timeout = false } = {}) {
  setSync('offline');
  // 写入超时：请求可能已经到了云端，只是回应没回来，不能说「没保存」
  if (isWrite(builder)) return fail(timeout ? '网络太慢，没能确认刚才的修改有没有保存。网络恢复后页面会自动刷新，请看一眼再决定是否重做。' : OFFLINE_WRITE_MSG, 'WB_OFFLINE');
  const quiet = Date.now() - lastNetToast < 20000; if (!quiet) lastNetToast = Date.now();
  return fail(msg || OFFLINE_MSG, 'WB_OFFLINE', { quiet });
}

/**
 * 执行查询构造器，返回 data；出错时提示并抛出。
 * expect：预料之中的错误码（如 23505 记录已存在）——不弹提示、不改同步状态，照样抛出（err.expected = true），由调用方处理。
 */
export async function run(builder, { expect = [] } = {}) {
  const auth = window.cloud && window.cloud.auth;
  if (auth && typeof auth.getAccessToken === 'function' && !(await auth.getAccessToken().catch(() => null))) {
    // 拿不到凭证：还存着登录信息 → 断网刷新失败，不能带着匿名身份去查（会读到空列表）
    if (hasStoredSession()) throw offline(builder);
    setSync('error');
    throw fail(MESSAGES.PGRST301, 'PGRST301');
  }
  let timer;
  const res = await Promise.race([builder, new Promise(r => { timer = setTimeout(() => r({ error: { message: 'timeout', code: 'WB_TIMEOUT' } }), TIMEOUT_MS); })])
    .catch(e => ({ error: { message: String(e && e.message || e), code: '' } }))
    .finally(() => clearTimeout(timer));
  if (res && res.error) {
    const e = res.error, m = e.message || '';
    // SDK 的网络错误：{ kind: 'network', status: 0 }；云端 5xx：kind 'backend-unavailable'
    if (e.code === 'WB_TIMEOUT' || e.kind === 'network' || e.kind === 'backend-unavailable' || e.status === 0 || (!e.code && NET.test(m))) {
      throw offline(builder, e.code === 'WB_TIMEOUT' ? '网络太慢，等了 15 秒没有回应。页面保留当前内容，稍后会自动重试。'
        : e.kind === 'backend-unavailable' ? '云端暂时不可用。页面保留当前内容，稍后会自动重试。' : OFFLINE_MSG, { timeout: e.code === 'WB_TIMEOUT' });
    }
    if (expect.includes(e.code)) { setSync('ok'); const x = fail(m || e.code, e.code, { quiet: true }); x.expected = true; throw x; }
    setSync('error');
    const msg = MESSAGES[e.code] || (m.includes('JWT') ? MESSAGES.PGRST301 : (m || '操作失败'));
    throw fail(msg, e.code);
  }
  setSync('ok');
  return res ? res.data : null;
}

/** 用户的一个操作没做完（中途哪一步失败都算）：网络原因时明确说「没保存」，其他未提示过的错误补一句 */
export function saveFailed(e) {
  if (e && e.code === 'WB_OFFLINE') { if (!/修改/.test(e.message)) toast(OFFLINE_WRITE_MSG); }
  else if (!e || !e.handled) toast('没有保存成功，请重试');
}

/** 分页读完整张表（导出、备份用；平台可能限制单次返回的行数） */
export async function runAll(makeQuery, pageSize = 500) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const rows = await run(makeQuery().range(from, from + pageSize - 1));
    out.push(...(rows || []));
    if (!rows || rows.length < pageSize) return out;
  }
}

// ---------- 变化通知：仓储写入后调用 changed()，当前视图自动重绘 ----------
const listeners = new Set();
export const onChanged = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export function changed(what) { listeners.forEach(fn => { try { fn(what); } catch (e) { console.error(e); } }); }
