/* sw.js — Service Worker：只负责接收推送、显示通知、点击通知打开对应页面。
 * 不做离线缓存（避免更新后看到旧页面）。必须放在根路径，作用域才能覆盖整个应用。
 */
'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = { title: '工作台', body: event.data && event.data.text() }; }
  const title = data.title || '工作台';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    data: { url: data.url || '/#/today' },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  // 只打开本站地址：推送内容里的 url 若指向别的网站（或写坏了），一律改开首页
  let url = new URL('/#/today', self.location.origin).href;
  try { const u = new URL((event.notification.data && event.notification.data.url) || '/#/today', self.location.origin); if (u.origin === self.location.origin) url = u.href; } catch (_) { /* 用首页 */ }
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) {
        await w.focus();
        if ('navigate' in w) return w.navigate(url);
        return;
      }
    }
    return self.clients.openWindow(url);
  })());
});
