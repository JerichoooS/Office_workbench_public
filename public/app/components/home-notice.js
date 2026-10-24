// home-notice.js — 首页提示卡：同一时间最多一张（方案约定），按下面的顺序取第一张有内容的。
// 每种提示是 components/notices/ 下的一个文件，导出 async function notice() → null 或 { html, bind(el, refresh) }：
//   html：卡片内容（外层 .notice 由这里包）；bind：绑定按钮事件，refresh() 重新挑一张显示（处理完、关掉之后调用）。
// 提示读不到数据（弱网）就当没有，不影响首页。

import * as delivery from './notices/delivery.js';   // 提醒没送达 / 提醒服务没在运行
import * as wrapup from './notices/wrapup.js';       // 项目过了结束日还有没做完的事：先收尾再归档

const ORDER = [delivery, wrapup];

export async function mountHomeNotice(el) {
  if (!el) return;
  const refresh = () => mountHomeNotice(el);
  for (const m of ORDER) {
    let n = null;
    try { n = await m.notice(); } catch (e) { console.warn('首页提示读取失败', e); }
    if (!el.isConnected) return;
    if (n) {
      el.innerHTML = `<div class="notice" role="status">${n.html}</div>`;
      if (n.bind) n.bind(el.firstElementChild, refresh);
      return;
    }
  }
  el.innerHTML = '';
}
