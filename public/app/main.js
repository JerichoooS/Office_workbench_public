// main.js — 应用入口：启动 → 登录检查 → 外框 → 路由
// 新增页面：在 views/ 加文件，然后在下面 route() 注册，并在 components/shell.js 的导航里加入口。

import { route, current, onChange } from './core/router.js';
import { restoreAuth } from './core/auth.js';
import { onChanged } from './data/db.js';
import { getSettings } from './data/repos/settings.js';
import { listContacts } from './data/repos/contacts.js';
import { autoArchive } from './data/repos/tasks.js';
import { loadFeatures } from './data/features.js';
import { initOutbox } from './data/outbox.js';
import { renderShell, updateNav } from './components/shell.js';
import { renderLogin } from './views/login.js';
import { applyAppearance } from './core/appearance.js';
import { esc } from './core/dom.js';

import * as today from './views/today.js';
import * as board from './views/board.js';
import * as tasks from './views/tasks.js';
import * as taskDetail from './views/task-detail.js';
import * as calendar from './views/calendar.js';
import * as collections from './views/collections.js';
import * as all from './views/all.js';
import * as settings from './views/settings.js';
import { openTodo } from './components/todo-detail.js';
import { closeDrawer, closeSheet, closeLeft } from './core/dom.js';
import { registerSW, handOverServerToken } from './core/pwa.js';
import { initLifecycle } from './core/lifecycle.js';

route('/today', today);
route('/board', board);
route('/tasks', tasks);
route('/tasks/:id', taskDetail);
route('/calendar', calendar);
route('/collections', collections);
route('/all', all);
route('/settings', settings);
route('/settings/:section', settings);

let session = null, mounted = null, rendering = false, again = false, handledHash = null;

/** 渲染当前路由；数据变化时也走这里（保持滚动位置）
 *  读取失败（多半是网络）：数据刷新时保留当前画面不动；切到新页面时显示「重试」占位，不留下上一页的内容 */
async function show({ keepScroll = false } = {}) {
  if (rendering) { again = true; return; }
  rendering = true;
  const r = current();
  const main = document.getElementById('main');
  try {
    const scroller = window.matchMedia('(max-width: 760px)').matches ? document.scrollingElement : main;
    const y = keepScroll ? scroller.scrollTop : 0;
    updateNav(r.path);
    main.classList.toggle('enter', !keepScroll);
    if (mounted && mounted.cleanup) mounted.cleanup();
    mounted = null;
    const cleanup = await r.view.mount(main, r.params, { session });
    mounted = { cleanup, path: r.path };
    scroller.scrollTop = y;
    // ?todo=<id>（来自通知或链接）：每个地址只自动打开一次详情
    const todoId = new URLSearchParams(location.hash.split('?')[1] || '').get('todo');
    if (todoId && handledHash !== location.hash) openTodo(todoId);
    handledHash = location.hash;
  } catch (e) {
    console.error('[workbench] 页面加载失败', e);
    if (!keepScroll || !main.firstElementChild) {
      main.innerHTML = `<div class="wrap"><div class="placeholder" role="alert">${esc(e && e.handled ? e.message : '这一页没能打开。')}<button class="btn small" data-retry>重试</button></div></div>`;
      main.querySelector('[data-retry]').onclick = () => show();
    }
  } finally {
    rendering = false;
    if (again) { again = false; show({ keepScroll: true }); }
  }
}

window.WBBoot.initCloud()
  .then(() => restoreAuth())
  .then(async ({ session: s, error }) => {
    window.WBBoot.settle();
    const root = document.getElementById('root');
    if (!s) { renderLogin(root, error); return; }
    session = s;
    applyAppearance();
    // 设置和联系人读不到（弱网）也照样打开外框；各页面会自己重试。loadFeatures：云库执行到哪一步（第二阶段功能开不开）
    await Promise.all([getSettings(), listContacts(), loadFeatures()]).catch(() => {});
    renderShell(root, session);
    document.addEventListener('touchstart', () => {}, { passive: true });   // iOS 需要它才会显示 :active 点按反馈
    autoArchive().catch(() => {});
    registerSW();
    handOverServerToken();   // 管理员交接模式：服务器缺口令时交接（非管理员无效果）；回到前台时 lifecycle.js 会再做一次
    initLifecycle();
    initOutbox();   // 没信号时记下的：补存一次，并在网络恢复、回到前台时自动补存
    onChange(() => {
      // 从详情/弹层里点了别的页面（如底部「设置」）：先关掉面板再跳转
      if (!/[?&]todo=/.test(location.hash)) { closeDrawer(); closeLeft(); if (document.querySelector('.sheet.open')) closeSheet(); }
      show();
    });
    onChanged(() => show({ keepScroll: true }));
    await show();
  })
  .catch(e => window.WBBoot.fail(e));
