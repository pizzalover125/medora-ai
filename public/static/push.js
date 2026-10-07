window.Push = (() => {
  'use strict';

  const listeners = new Set();
  let token = null;
  let registration = null;

  const supported = 'serviceWorker' in navigator && 'PushManager' in window &&
    'Notification' in window && window.isSecureContext;

  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches ||
    navigator.standalone === true;

  const ready = (async () => {
    if (!('serviceWorker' in navigator)) return null;
    try {
      const cache = await caches.open('ask-home');
      await cache.put('/__home', new Response(location.pathname));
    } catch (_) {  }
    try {
      registration = await navigator.serviceWorker.register('/sw.js', {scope: '/'});
      navigator.serviceWorker.addEventListener('message', (event) => {
        const data = event.data || {};
        if (data.type !== 'push') return;
        listeners.forEach((fn) => { try { fn(data.payload || {}); } catch (_) {  } });
      });
      return navigator.serviceWorker.ready;
    } catch (error) {
      console.warn('[push] no service worker', error);
      return null;
    }
  })();

  function base64ToBytes(base64) {
    const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
      .replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  }

  async function status() {
    if (isIOS && !standalone && !supported) return 'needs-install';
    if (!supported) return isIOS && !standalone ? 'needs-install' : 'unsupported';
    if (Notification.permission === 'denied') return 'blocked';
    const reg = await ready;
    if (!reg) return 'unsupported';
    const sub = await reg.pushManager.getSubscription();
    return sub && Notification.permission === 'granted' ? 'on' : 'off';
  }

  async function send(subscription) {
    await fetch('/api/push', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token, subscription: subscription.toJSON()}),
    });
  }

  async function enable(withToken) {
    if (withToken !== undefined) token = withToken;
    if (!supported) throw new Error(isIOS && !standalone
      ? 'On iPhone, add this page to your Home Screen first (Share, then Add to Home Screen).'
      : 'This browser cannot show notifications.');

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Notifications were not allowed.');

    const keyResponse = await fetch('/api/push/key', {cache: 'no-store'});
    const {key} = await keyResponse.json();
    if (!key) throw new Error('Notifications are not set up on the server yet.');

    const reg = await ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64ToBytes(key),
      });
    }
    await send(sub);
    return 'on';
  }

  async function refresh(withToken) {
    if (withToken !== undefined) token = withToken;
    if (!supported || Notification.permission !== 'granted') return;
    const reg = await ready;
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub) send(sub).catch(() => {});
  }

  return {
    status,
    enable,
    refresh,
    on: (fn) => listeners.add(fn),
    get isIOS() { return isIOS; },
    get standalone() { return standalone; },
  };
})();
