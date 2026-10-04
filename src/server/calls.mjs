/* Video calls between the senior and one contact.

   Only the signalling lives here: the offer, the answer, and the network
   candidates the two browsers need to find each other. The picture and the
   sound go straight between them. In the Flask app this was a dict in
   memory; a function forgets everything between requests, so the one call
   in progress is a blob instead. Its state changes rarely and one end at a
   time; the signals are the chatty part, and both ends send them at once,
   so each is a key of its own - sig/<call>/<to>/<time> - written once and
   never rewritten, which nothing racing can lose.

   Placing a call also pushes to the other side's devices, which is what
   rings a phone whose page is closed. */

import crypto from 'node:crypto';
import * as messages from './messages.mjs';
import * as push from './push.mjs';
import { HttpError, keys, read, remove, update, write } from './store.mjs';

const RING_SECONDS = 45;
const LINGER_SECONDS = 15;
const MAX_SIGNALS = 400;
const ringEnd = (call) => Date.parse(call.started) + RING_SECONDS * 1000;
const sigPrefix = (callId, to) => `sig/${callId}/${to}/`;
const MAX_SIGNAL_BYTES = 64 * 1024;
const SIGNAL_KINDS = ['offer', 'answer', 'candidate'];

const KEY = 'call';
const none = () => ({ call: null });

/* Where the two browsers look for each other. A caretaker is almost never on
   the senior's wifi, so a relay matters far more here than it did on one
   network: TURN_URL (plus TURN_USERNAME / TURN_PASSWORD), or a Metered.ca
   key that hands out short-lived TURN credentials. */
export async function iceServers() {
  const servers = [];
  const stun = process.env.STUN_URL ?? 'stun:stun.l.google.com:19302';
  if (stun) servers.push({ urls: stun.split(',').map((s) => s.trim()) });

  const { METERED_DOMAIN: domain, METERED_API_KEY: key } = process.env;
  if (domain && key) {
    try {
      const res = await fetch(`https://${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(key)}`,
                              { signal: AbortSignal.timeout(4000) });
      if (res.ok) servers.push(...(await res.json()));
    } catch (error) {
      console.warn('metered turn failed', error.message);
    }
  }

  const turn = (process.env.TURN_URL || '').trim();
  if (turn) {
    const server = { urls: turn.split(',').map((s) => s.trim()) };
    if (process.env.TURN_USERNAME) {
      server.username = process.env.TURN_USERNAME.trim();
      server.credential = (process.env.TURN_PASSWORD || '').trim();
    }
    servers.push(server);
  }
  return servers;
}

const other = (side) => (side === messages.SENIOR ? messages.CONTACT : messages.SENIOR);
const secondsSince = (iso) => (Date.now() - Date.parse(iso)) / 1000;

function view(call) {
  if (!call) return null;
  const { ended, ...shown } = call;
  return { ...shown, contact: { ...call.contact } };
}

function spokenLength(seconds) {
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? '1 min' : `${minutes} min`;
}

/* What the conversation should say about a call that just ended - written
   once the state change has actually been saved. */
async function writeHistory(call) {
  let text;
  let wasRead = true;
  if (call.reason === 'declined') {
    text = 'Video call declined';
  } else if (call.answered) {
    text = `Video call · ${spokenLength(Math.round(secondsSince(call.answered)))}`;
  } else {
    text = 'Missed video call';
    wasRead = false;
  }
  // Keyed by the call, so two ends noticing the same timeout write it once.
  const at = call.reason === 'no_answer' ? ringEnd(call) : Date.parse(call.ended);
  await messages.logEvent(call.slug, call.caller, text, { read: wasRead, at, id: `call${call.id}` });

  if (!call.answered && call.reason !== 'declined') {
    const callee = call.caller === messages.SENIOR ? call.slug : 'senior';
    const who = call.caller === messages.SENIOR ? call.contact.calls : call.contact.name;
    await push.notify(callee, {
      kind: 'missed', slug: call.slug, title: `Missed call from ${who}`,
      body: 'Tap to call back or send a message.', tag: `call-${call.slug}`,
    });
  }
}

function finish(call, reason) {
  if (call.state === 'ended') return false;
  call.state = 'ended';
  call.reason = reason;
  call.ended = reason === 'no_answer' ? new Date(ringEnd(call)).toISOString() : new Date().toISOString();
  return true;
}

/* Time out a ringing call nobody answered, forget an ended one. Returns
   whether anything changed, and the call to write history for. */
function expire(store) {
  const call = store.call;
  if (!call) return { changed: false };
  let finished = null;
  if (call.state === 'ringing' && secondsSince(call.started) > RING_SECONDS) {
    if (finish(call, 'no_answer')) finished = call;
  }
  if (call.state === 'ended' && secondsSince(call.ended) > LINGER_SECONDS) {
    store.call = null;
    return { changed: true, finished };
  }
  return { changed: !!finished, finished };
}

const active = (store, slug) => {
  const call = store.call;
  if (!call || call.state === 'ended') return null;
  if (slug && call.slug !== slug) return null;
  return call;
};

async function mutate(fn) {
  let finished = null;
  const out = await update(KEY, none, (store) => {
    const expired = expire(store);
    finished = expired.finished;
    const result = fn(store);
    // Nothing to do for the caller, but a timeout still has to be saved.
    if (result === update.SKIP && expired.changed) return null;
    return result;
  });
  if (finished) await writeHistory(finished);
  return out;
}

export async function place(slug, caller) {
  const contact = await messages.findContact(slug);
  if (!contact) throw new HttpError(404, 'contact_not_found', 'There is no contact by that name.');

  // Signals from calls that are over are no use to anyone.
  const stale = await keys('sig/');
  await Promise.all(stale.map((key) => remove(key)));

  const call = await mutate((store) => {
    if (active(store)) throw new HttpError(409, 'busy', 'That line is busy at the moment.');
    store.call = {
      id: crypto.randomBytes(4).toString('hex'),
      slug: contact.slug,
      contact: messages.publicContact(contact),
      caller,
      state: 'ringing',
      reason: null,
      started: new Date().toISOString(),
      answered: null,
      ended: null,
    };
    return view(store.call);
  });

  // Ring the far end even if nobody there has the page open.
  const toSenior = caller === messages.CONTACT;
  await push.notify(toSenior ? 'senior' : contact.slug, {
    kind: 'call', slug: contact.slug, callId: call.id,
    title: toSenior ? `${contact.name} is calling` : `${contact.calls} is calling`,
    body: 'Video call - tap to answer.', tag: `call-${contact.slug}`,
  }, { urgent: true, ttl: RING_SECONDS });

  return call;
}

export async function answer(slug, who) {
  return mutate((store) => {
    const call = active(store, slug);
    if (!call || call.state !== 'ringing') {
      throw new HttpError(404, 'no_call', 'That call is no longer ringing.');
    }
    if (who === call.caller) throw new HttpError(400, 'invalid_call', 'You cannot answer your own call.');
    call.state = 'connected';
    call.answered = new Date().toISOString();
    return view(call);
  });
}

export async function end(slug, who, reason) {
  let ended = null;
  const out = await mutate((store) => {
    const call = active(store, slug);
    if (!call) return update.SKIP;
    if (reason !== 'declined' && reason !== 'failed') {
      reason = call.state === 'connected' ? 'hung_up' : 'cancelled';
    }
    if (reason === 'cancelled' && who !== call.caller) reason = 'declined';
    finish(call, reason);
    ended = { ...call };
    return view(call);
  });
  if (ended) await writeHistory(ended);
  return out ?? null;
}

export async function signal(slug, sender, kind, data) {
  if (!SIGNAL_KINDS.includes(kind)) throw new HttpError(400, 'invalid_call', 'That is not something to signal.');
  if (data == null || !['object', 'string'].includes(typeof data)) {
    throw new HttpError(400, 'invalid_call', 'That signal has nothing in it.');
  }
  if (JSON.stringify(data).length > MAX_SIGNAL_BYTES) {
    throw new HttpError(400, 'invalid_call', 'That signal is too large.');
  }

  const store = await read(KEY, none);
  const call = active(store, slug);
  if (!call || secondsSince(call.started) > 6 * 3600) {
    throw new HttpError(404, 'no_call', 'That call is over.');
  }
  const at = String(Date.now()).padStart(14, '0');
  const key = `${sigPrefix(call.id, other(sender))}${at}-${crypto.randomBytes(3).toString('hex')}`;
  await write(key, { kind, data });
  return view(call);
}

/* The call this side can see, and whatever was signalled to it since
   `since`. A plain read unless the call has timed out. */
export async function poll(viewer, slug, since = '') {
  let store = await read(KEY, none);
  const probe = structuredClone(store);
  if (expire(probe).changed) {
    await mutate(() => null);
    store = await read(KEY, none);
  }

  const call = store.call;
  if (!call || (slug && call.slug !== slug)) return { call: null, signals: [], cursor: 0 };

  // The cursor is the last signal key this side has collected.
  const prefix = sigPrefix(call.id, viewer);
  // Instances' clocks can disagree by a little, so look back a few seconds
  // past the cursor; the browser drops signals it has already seen.
  const sinceMs = Number.parseInt(String(since || '0').split('-')[0], 10) || 0;
  const after = sinceMs ? String(Math.max(0, sinceMs - 5000)).padStart(14, '0') : '';
  const fresh = (await keys(prefix)).filter((key) => key.slice(prefix.length) > after)
    .slice(0, MAX_SIGNALS);
  const bodies = await Promise.all(fresh.map((key) => read(key, null)));
  const signals = fresh.map((key, i) => (bodies[i] ? { seq: key.slice(prefix.length), ...bodies[i] } : null))
    .filter(Boolean);
  return {
    call: view(call),
    signals,
    cursor: fresh.length ? fresh[fresh.length - 1].slice(prefix.length) : since,
  };
}
