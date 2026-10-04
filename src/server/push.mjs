/* Web Push - what makes "call me any time" true.

   Polling only works while a page is open and in front. A push reaches the
   browser itself, so a caretaker's call rings the senior's device with the
   assistant's tab in the background or closed, and the senior's reply buzzes
   the caretaker's phone in their pocket. The service worker (public/sw.js)
   decides what to do with it: hand it to an open page, or show a
   notification that opens one.

   Each device registers once. Subscriptions are kept per side - the senior's
   devices, and each contact's devices under their slug - and a subscription
   the push service says is gone is forgotten on the spot. */

import crypto from 'node:crypto';
import webpush from 'web-push';
import { keys, read, remove, write } from './store.mjs';

/* One key per device - push/<side>/<hash of endpoint> - so two devices
   registering at once can never knock each other out. */
const prefix = (slug) => `push/${slug ? `c-${slug}` : 'senior'}/`;
const keyFor = (slug, endpoint) =>
  prefix(slug) + crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 32);

let configured = null;
function ready() {
  if (configured !== null) return configured;
  const { VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: priv } = process.env;
  configured = !!(pub && priv);
  if (configured) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:medora@example.com', pub, priv);
  }
  return configured;
}

export const publicKey = () => (ready() ? process.env.VAPID_PUBLIC_KEY : null);

function valid(sub) {
  return sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) &&
    sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string';
}

export async function subscribe(slug, sub) {
  if (!valid(sub)) return false;
  await write(keyFor(slug, sub.endpoint),
              { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
  return true;
}

export async function unsubscribe(slug, endpoint) {
  await remove(keyFor(slug, endpoint));
}

export async function forgetContact(slug) {
  await Promise.all((await keys(prefix(slug))).map((key) => remove(key)));
}

/* Send one payload to every device on one side. `to` is 'senior' or a
   contact's slug. Never throws: a notification is a courtesy, and the
   message or call it is about has already been saved. */
export async function notify(to, payload, { urgent = false, ttl = 3600 } = {}) {
  if (!ready()) return;
  const slug = to === 'senior' ? null : to;
  let targets;
  try {
    targets = (await Promise.all((await keys(prefix(slug))).map((key) => read(key, null))))
      .filter(Boolean);
  } catch (error) {
    console.warn('push: could not read subscriptions', error.message);
    return;
  }
  if (!targets.length) return;

  const body = JSON.stringify(payload);
  const gone = [];
  await Promise.allSettled(targets.map(async (sub) => {
    try {
      await webpush.sendNotification(sub, body, { TTL: ttl, urgency: urgent ? 'high' : 'normal' });
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) gone.push(sub.endpoint);
      else console.warn('push failed', error.statusCode || '', error.body || error.message);
    }
  }));

  for (const endpoint of gone) {
    await unsubscribe(slug, endpoint).catch(() => {});
  }
}
