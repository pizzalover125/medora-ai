self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (_) { payload = {}; }

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    windows.forEach((client) => client.postMessage({type: 'push', payload}));

    const onScreen = windows.some((client) => client.visibilityState === 'visible');
    if (onScreen) return;

    const call = payload.kind === 'call';
    await self.registration.showNotification(payload.title || 'Ask', {
      body: payload.body || '',
      tag: payload.tag || payload.kind || 'ask',
      renotify: true,
      requireInteraction: call,
      vibrate: call ? [400, 200, 400, 200, 400] : [200],
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: {kind: payload.kind, slug: payload.slug},
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    const open = windows.find((client) => 'focus' in client);
    if (open) {
      await open.focus();
      open.postMessage({type: 'push', payload: event.notification.data || {}});
      return;
    }
    const cache = await caches.open('ask-home');
    const stored = await cache.match('/__home');
    const home = stored ? await stored.text() : '/';
    await self.clients.openWindow(home);
  })());
});
