// lifecycle.js — 主屏幕 App 的「回到前台」处理、下拉刷新、新版本提示
//
// 背景：添加到主屏幕后，iPhone 通常把 App 挂在后台而不是关掉；再打开时页面不会重新加载，
// 所以「启动时才做的事」需要在回到前台时再做一遍：
//   1) 把服务器口令交给服务器（管理员交接模式下，服务器重启/重新部署后需要）
//   2) 重新拉一次数据（别的设备改过的内容）；联系人、设置、标签有模块缓存，要强制刷新
//   3) 检查有没有新部署的版本，有就提示「点击更新」（整页重新加载才能用上新代码）
// 下拉刷新只重新拉数据，不整页重载（快、不丢当前页面状态）；有新版本时才建议整页更新。

import { changed } from '../data/db.js';
import { listContacts } from '../data/repos/contacts.js';
import { getSettings } from '../data/repos/settings.js';
import { listTags } from '../data/repos/tags.js';
import { handOverServerToken } from './pwa.js';
import { drawerOpen, toast } from './dom.js';

let bootVersion = null, hiddenAt = 0;

async function currentVersion() {
  try { return (await (await fetch('/api/version', { cache: 'no-store' })).json()).version; } catch (_) { return null; }
}

function showUpdateBanner() {
  if (document.getElementById('update-banner')) return;
  const b = document.createElement('button');
  b.id = 'update-banner';
  b.className = 'update-banner';
  b.textContent = '工作台有新版本 · 点这里更新';
  b.onclick = () => location.reload();
  document.body.appendChild(b);
}

export async function checkVersion() {
  const v = await currentVersion();
  if (v && bootVersion && v !== bootVersion) showUpdateBanner();
  return v;
}

/** 回到前台 / 下拉刷新时做的事 */
export async function refreshAll({ reason = 'resume' } = {}) {
  await handOverServerToken();
  // 这三样在仓储里有缓存，changed() 重绘时不会重新读：别的设备新建的等待对象会显示成空，所以先强制刷新（失败不影响重绘）
  await Promise.all([listContacts(true), getSettings(true), listTags(true)]).catch(() => {});
  changed(reason);
  await checkVersion();
}

export async function initLifecycle() {
  bootVersion = await currentVersion();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (Date.now() - hiddenAt > 30 * 1000) refreshAll();   // 离开超过 30 秒再回来才刷新，避免来回切换时频繁请求
  });
  initPullToRefresh();
}

// ---------- 下拉刷新（只在手机布局；在页面最顶部往下拉） ----------
function initPullToRefresh() {
  const THRESHOLD = 70, MAX = 110;
  const ind = document.createElement('div');
  ind.className = 'ptr';
  ind.innerHTML = '<span class="ptr-dot"></span><span class="ptr-text">下拉刷新</span>';
  document.body.appendChild(ind);
  let startY = null, dist = 0, busy = false;
  const mobile = () => window.matchMedia('(max-width: 760px)').matches;
  const blocked = () => busy || drawerOpen() || document.querySelector('.sheet.open');

  document.addEventListener('touchstart', e => {
    if (!mobile() || blocked() || document.scrollingElement.scrollTop > 0 || e.touches.length !== 1) { startY = null; return; }
    startY = e.touches[0].clientY; dist = 0;
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (startY === null) return;
    dist = Math.min(MAX, Math.max(0, (e.touches[0].clientY - startY) * 0.5));
    if (document.scrollingElement.scrollTop > 0) { dist = 0; }
    ind.style.transform = `translate(-50%, ${dist - 44}px)`;
    ind.classList.toggle('ready', dist >= THRESHOLD);
    ind.querySelector('.ptr-text').textContent = dist >= THRESHOLD ? '松开刷新' : '下拉刷新';
  }, { passive: true });

  document.addEventListener('touchend', async () => {
    if (startY === null) return;
    startY = null;
    if (dist < THRESHOLD) { ind.style.transform = ''; return; }
    busy = true;
    ind.classList.add('busy');
    ind.querySelector('.ptr-text').textContent = '正在刷新…';
    try { await refreshAll({ reason: 'pull' }); toast('已刷新'); }
    finally { busy = false; ind.classList.remove('busy', 'ready'); ind.style.transform = ''; }
  });
}
