// auth.js — 登录：微信扫码（OAuth 回调只在根路径处理）、会话恢复、退出
// 沿用 v1 已在线上验证过的流程（legacy/v1-public/js/auth.js）。

const B = () => window.WBBoot;
const CALLBACK_KEYS = ['code', 'state', 'provider', 'error', 'error_description'];

function clearAuthParams() {
  const url = new URL(location.href);
  CALLBACK_KEYS.forEach(k => url.searchParams.delete(k));
  history.replaceState(null, '', url.pathname + url.search + url.hash);
}

function authError(code) { const e = new Error('Authentication unavailable'); e.code = code || 'WB_AUTH_UNAVAILABLE'; return e; }

export function authMessage(error, fallback) {
  if (error && error.code === 'WB_AUTH_TIMEOUT') return '登录请求超时，请检查网络后重试。';
  if (error && (error.kind === 'network' || error.kind === 'backend-unavailable')) return '登录服务暂时不可用，请稍后重试。';
  return fallback;
}

/** 恢复会话；有 OAuth 回调参数时先完成回调。返回 { session, error } */
export async function restoreAuth() {
  const url = new URL(location.href);
  if (!url.searchParams.has('code') && !url.searchParams.has('error')) return { session: await resumeSession() };
  if (url.pathname !== '/' && url.pathname !== '/index.html') {
    location.replace(location.origin + '/?' + url.searchParams.toString());
    return new Promise(() => {});
  }
  const provider = url.searchParams.get('provider');
  try {
    if (provider !== 'workbuddy' && provider !== 'wechat') return { session: null, error: '授权回调缺少有效的登录方式，请重新登录。' };
    const handler = provider === 'workbuddy' ? cloud.auth.handleWorkBuddyCallback : cloud.auth.handleWechatWebCallback;
    if (typeof handler !== 'function') return { session: null, error: '暂时无法使用此方式登录。' };
    const res = await B().withTimeout(handler.call(cloud.auth), 12000, 'WB_AUTH_TIMEOUT');
    if (!res || res.error) return { session: null, error: authMessage(res && res.error, '授权未完成或已过期，请重新登录。') };
    return { session: res.data || await resumeSession() };
  } catch (error) {
    return { session: null, error: authMessage(error, '授权未完成，请重新登录。') };
  } finally {
    clearAuthParams();   // OAuth code 只能用一次
  }
}

async function resumeSession() {
  try {
    const res = await B().withTimeout(cloud.auth.getSession(), 10000, 'WB_AUTH_TIMEOUT');
    if (!res) throw authError();
    if (res.error) {
      if (res.error.kind === 'unauthenticated' || res.error.kind === 'invalid_grant') return null;
      throw authError();
    }
    return res.data || null;
  } catch (error) {
    if (error && error.code === 'WB_AUTH_TIMEOUT') throw error;
    throw authError();
  }
}

/** 发起微信扫码登录；返回错误文案或跳转 */
export async function signInWechat() {
  try {
    const res = await B().withTimeout(cloud.auth.signInWithOAuth({ provider: 'wechat', redirectTo: location.origin }), 12000, 'WB_AUTH_TIMEOUT');
    if (!res || res.error || !res.data || !res.data.url) return authMessage(res && res.error, '未能发起微信登录，请重试。');
    location.assign(res.data.url);
    return null;
  } catch (error) {
    return authMessage(error, '未能发起微信登录，请稍后重试。');
  }
}

export async function signOut() {
  const res = await B().withTimeout(cloud.auth.signOut(), 10000, 'WB_AUTH_TIMEOUT');
  if (res && res.error) throw authError();
  location.replace(location.origin + '/');
}

export const userName = s => (s && s.user && (s.user.name || s.user.nickname)) || '我';
