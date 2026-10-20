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
  const url = new URL((event.notification.data && event.notification.data.url) || '/#/today', self.location.origin).href;
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
