/* ---------------------------------------------------------------------------
   The service worker: where a push lands when the page might not be open.

   If a page from this site is open and on screen, the push is handed to it
   (static/push.js) - the page shows the call or the message itself. If not,
   it becomes a notification, and tapping that opens the page it is about: a
   caretaker's conversation for them, the assistant for the senior. A call
   keeps its notification up until it is answered or dismissed.
--------------------------------------------------------------------------- */

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
    // Any open page from this site is the right one: there is one per device.
    const open = windows.find((client) => 'focus' in client);
    if (open) {
      await open.focus();
      open.postMessage({type: 'push', payload: event.notification.data || {}});
      return;
    }
    // Nothing open. The registration scope is the whole site, so start from
    // the page that registered it - stored by push.js on each load.
    const cache = await caches.open('ask-home');
    const stored = await cache.match('/__home');
    const home = stored ? await stored.text() : '/';
    await self.clients.openWindow(home);
  })());
});
