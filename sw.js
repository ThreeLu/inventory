// 只负责收推送：每晚 8 点「今天穿的要洗吗」等提醒。不做离线缓存，免得用户看到旧版本。

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let msg = { title: '物品档案', body: '', url: './' };
  try { msg = { ...msg, ...event.data.json() }; } catch { if (event.data) msg.body = event.data.text(); }
  event.waitUntil(self.registration.showNotification(msg.title, {
    body: msg.body, icon: 'icon-180.png', badge: 'icon-180.png', tag: msg.tag || 'inventory', data: { url: msg.url },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) { await w.navigate(url).catch(() => {}); return w.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});
