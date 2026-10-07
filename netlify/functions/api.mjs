/* Every /api/* route, in one function - the same routes app.py served, plus
   the ones caretaker links need.

   Two kinds of caller (see src/server/auth.mjs): the senior's signed-in
   device, and a caretaker holding a link token. A route says which it
   accepts, and a caretaker is only ever handed their own conversation. */

import * as auth from '../../src/server/auth.mjs';
import * as brain from '../../src/server/brain.mjs';
import * as calls from '../../src/server/calls.mjs';
import { DAY_NAMES, MONTH_NAMES, isoDate, timezone, useTimezone, wallNow } from '../../src/server/clock.mjs';
import * as events from '../../src/server/events.mjs';
import * as intents from '../../src/server/intents.mjs';
import * as medicines from '../../src/server/medicines.mjs';
import * as messages from '../../src/server/messages.mjs';
import * as news from '../../src/server/news.mjs';
import * as push from '../../src/server/push.mjs';
import { HttpError } from '../../src/server/store.mjs';
import * as stt from '../../src/server/stt.mjs';
import * as weather from '../../src/server/weather.mjs';

export const config = { path: '/api/*' };

const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
});

async function body(req) {
  const data = await req.json().catch(() => null);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
}

const linkFor = (req, contact) => `${new URL(req.url).origin}/c/${contact.token}`;

/* The caretaker behind a token, or a 404 that does not say whether the
   token ever existed. */
async function caretaker(token) {
  const contact = await messages.contactByToken(token);
  if (!contact) throw new HttpError(404, 'link_not_found', 'This link is no longer active. Ask for a new one.');
  return contact;
}

/* For routes both sides use: a token makes it the caretaker, otherwise it
   must be the senior's device. */
async function caller(req, token) {
  if (token) {
    const contact = await caretaker(token);
    return { side: messages.CONTACT, slug: contact.slug, contact };
  }
  auth.requireSenior(req);
  return { side: messages.SENIOR, slug: null, contact: null };
}

/* Waiting on a push would slow down the reply it is about, so it finishes
   after the response when the platform allows it. */
function later(context, promise) {
  const safe = promise.catch((error) => console.warn('background task failed', error.message));
  if (context && typeof context.waitUntil === 'function') context.waitUntil(safe);
  else return safe;
  return undefined;
}

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const regex = new RegExp(`^/api${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}/?$`);
  routes.push({ method, regex, keys, handler });
};

/* ── session ─────────────────────────────────────────────────────────── */

route('GET', '/session', async ({ req }) =>
  json({ required: auth.loginRequired(), senior: auth.isSenior(req) }));

route('POST', '/session', async ({ req }) => {
  const data = await body(req);
  if (!auth.checkPasscode(data && data.passcode)) {
    await new Promise((resolve) => setTimeout(resolve, 900));   // slow down guessing
    return json({ error: 'wrong_passcode', message: 'That passcode is not right.' }, 401);
  }
  return json({ senior: true }, 200, { 'Set-Cookie': auth.sessionCookie(req) });
});

route('DELETE', '/session', async () => json({ senior: false }, 200, { 'Set-Cookie': auth.clearCookie() }));

route('GET', '/health', async () => json({
  ready: true, model: process.env.HACKCLUB_MODEL || 'google/gemini-3.8-flash',
  has_key: !!process.env.HACKCLUB_API_KEY, push: !!push.publicKey(),
}));

/* ── the senior's apps ───────────────────────────────────────────────── */

route('GET', '/weather', async ({ req, context }) => {
  auth.requireSenior(req);
  return json(await weather.forecast(context));
});

route('GET', '/events', async ({ req }) => {
  auth.requireSenior(req);
  return json({ events: await events.listAll() });
});

route('POST', '/events', async ({ req }) => {
  auth.requireSenior(req);
  const data = await body(req);
  if (!data) throw new HttpError(400, 'invalid_event', 'Please provide event details.');
  const event = await events.createEvent(data.title, data.date, data.time);
  return json({ event, events: await events.listAll() }, 201);
});

route('PATCH', '/events/:id', async ({ req, params }) => {
  auth.requireSenior(req);
  const data = await body(req);
  if (!data) throw new HttpError(400, 'invalid_event', 'Please provide event details.');
  const event = await events.updateEvent(params.id, data);
  return json({ event, events: await events.listAll() });
});

route('DELETE', '/events/:id', async ({ req, params }) => {
  auth.requireSenior(req);
  const event = await events.deleteEvent(params.id);
  return json({ event, events: await events.listAll() });
});

route('GET', '/medicines', async ({ req }) => {
  auth.requireSenior(req);
  return json(await medicines.snapshot());
});

route('POST', '/medicines', async ({ req }) => {
  auth.requireSenior(req);
  const d = await body(req);
  if (!d) throw new HttpError(400, 'invalid_medicine', 'Please provide the medicine details.');
  const medicine = await medicines.createMedicine(d.name, d.times, d.days, d.quantity, d.container);
  return json({ medicine, ...(await medicines.snapshot()) }, 201);
});

route('GET', '/medicines/due', async ({ req }) => {
  auth.requireSenior(req);
  return json({ due: await medicines.dueNow() });
});

route('DELETE', '/medicines/:id', async ({ req, params }) => {
  auth.requireSenior(req);
  const medicine = await medicines.deleteMedicine(params.id);
  return json({ medicine, ...(await medicines.snapshot()) });
});

route('POST', '/doses', async ({ req }) => {
  auth.requireSenior(req);
  const d = await body(req);
  if (!d) throw new HttpError(400, 'invalid_dose', 'Nothing to write down.');
  const dose = await medicines.recordDoseResult(d.container, d.minute ?? d.occurrenceMinute, d.status);
  return json({ dose, ...(await medicines.snapshot()) }, 201);
});

route('GET', '/news', async ({ req, url }) => {
  auth.requireSenior(req);
  const category = url.searchParams.get('category') || null;
  if (category && !news.BY_KEY[category]) {
    throw new HttpError(404, 'unknown_category', 'There is no news section by that name.');
  }
  const found = await news.stories(category ? [category] : null, url.searchParams.get('refresh') === '1');
  return json({ stories: found, categories: await news.catalogue(), selected: await news.selected(), category });
});

route('POST', '/news/settings', async ({ req }) => {
  auth.requireSenior(req);
  const d = await body(req);
  if (!d) throw new HttpError(400, 'invalid_categories', 'Please choose at least one kind of news.');
  await news.saveCategories(d.categories);
  return json({ categories: await news.catalogue(), selected: await news.selected() });
});

/* ── messages: the senior's side ─────────────────────────────────────── */

route('GET', '/contacts', async ({ req }) => {
  auth.requireSenior(req);
  return json({ contacts: await messages.overview() });
});

route('POST', '/contacts', async ({ req }) => {
  auth.requireSenior(req);
  const d = await body(req);
  if (!d) throw new HttpError(400, 'invalid_contact', 'Please give their name.');
  const contact = await messages.addContact(d);
  return json({ contact: messages.publicContact(contact), link: linkFor(req, contact),
                contacts: await messages.overview() }, 201);
});

route('DELETE', '/contacts/:slug', async ({ req, params, context }) => {
  auth.requireSenior(req);
  const removed = await messages.removeContact(params.slug);
  await later(context, push.forgetContact(removed.slug));
  return json({ contact: removed, contacts: await messages.overview() });
});

/* What this person may see and be told - set from their link panel. */
route('PATCH', '/contacts/:slug', async ({ req, params }) => {
  auth.requireSenior(req);
  const d = await body(req);
  if (!d || typeof d.permissions !== 'object') {
    throw new HttpError(400, 'invalid_contact', 'Nothing to change.');
  }
  const contact = await messages.setPermissions(params.slug, d.permissions);
  return json({ contact });
});

/* The link the senior shares. GET shows the current one; POST replaces it,
   which closes the old link immediately. */
route('GET', '/contacts/:slug/link', async ({ req, params }) => {
  auth.requireSenior(req);
  const contact = await messages.tokenFor(params.slug);
  return json({ link: linkFor(req, contact), contact: messages.publicContact(contact) });
});

route('POST', '/contacts/:slug/link', async ({ req, params }) => {
  auth.requireSenior(req);
  const contact = await messages.rotateToken(params.slug);
  return json({ link: linkFor(req, contact), contact: messages.publicContact(contact) });
});

route('GET', '/messages/:slug', async ({ req, params }) => {
  auth.requireSenior(req);
  return json({ messages: await messages.thread(params.slug, messages.SENIOR) });
});

route('POST', '/messages/:slug', async ({ req, params, context }) => {
  auth.requireSenior(req);
  const d = await body(req);
  if (!d) throw new HttpError(400, 'invalid_message', 'Please write a message first.');
  const { message, contact } = await messages.send(params.slug, messages.SENIOR, d.text);
  await later(context, push.notify(contact.slug, {
    kind: 'message', slug: contact.slug, title: contact.calls, body: message.text,
    tag: `msg-${contact.slug}`,
  }));
  return json({ message, messages: await messages.thread(params.slug, messages.SENIOR) }, 201);
});

/* ── messages: the caretaker's side ──────────────────────────────────── */

route('GET', '/c/:token', async ({ params }) => {
  const contact = await caretaker(params.token);
  return json({ contact: messages.publicContact(contact), vapidKey: push.publicKey() });
});

route('GET', '/c/:token/messages', async ({ params }) => {
  const contact = await caretaker(params.token);
  return json({ messages: await messages.thread(contact.slug, messages.CONTACT) });
});

route('POST', '/c/:token/messages', async ({ req, params, context }) => {
  const contact = await caretaker(params.token);
  const d = await body(req);
  if (!d) throw new HttpError(400, 'invalid_message', 'Please write a message first.');
  const { message } = await messages.send(contact.slug, messages.CONTACT, d.text);
  await later(context, push.notify('senior', {
    kind: 'message', slug: contact.slug, title: contact.name, body: message.text,
    tag: `msg-${contact.slug}`,
  }));
  return json({ message, messages: await messages.thread(contact.slug, messages.CONTACT) }, 201);
});

/* ── the caretaker's view of the day (only if the senior allowed it) ─── */

async function sharingDay(token) {
  const contact = await caretaker(token);
  if (!contact.permissions.day) {
    throw new HttpError(403, 'not_shared', `${contact.calls} hasn't shared their day with you.`);
  }
  return contact;
}

function spokenWhen(date, time) {
  const day = new Date(`${date}T00:00:00Z`);
  let text = `${DAY_NAMES[day.getUTCDay()]} ${day.getUTCDate()} ${MONTH_NAMES[day.getUTCMonth()]}`;
  if (time) {
    const [h, m] = time.split(':').map(Number);
    text += ` at ${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
  }
  return text;
}

route('GET', '/c/:token/today', async ({ params }) => {
  // Not shared is an ordinary answer here, not an error: the page just
  // hides the tab.
  const contact = await caretaker(params.token);
  if (!contact.permissions.day) return json({ shared: false });
  const today = isoDate(wallNow());
  const upcoming = (await events.listAll()).filter((e) => e.date >= today).slice(0, 8);
  return json({
    shared: true,
    timezone: timezone(),
    today,
    doses: await medicines.todayDoses(),
    events: upcoming,
  });
});

/* A reminder from a caretaker. It lands on the senior's calendar, so the
   assistant says it out loud when it comes due, and a note in the
   conversation says who added it. */
route('POST', '/c/:token/events', async ({ params, req, context }) => {
  const contact = await sharingDay(params.token);
  const d = await body(req);
  if (!d) throw new HttpError(400, 'invalid_event', 'Please provide event details.');
  const event = await events.createEvent(d.title, d.date, d.time, contact.name);
  const note = await messages.logNote(contact.slug, messages.CONTACT,
    `Added a reminder: ${event.title}, ${spokenWhen(event.date, event.time)}`);
  await later(context, push.notify('senior', {
    kind: 'message', slug: contact.slug, title: contact.name, body: note.text,
    tag: `msg-${contact.slug}`,
  }));
  const today = isoDate(wallNow());
  return json({ event, note, events: (await events.listAll()).filter((e) => e.date >= today).slice(0, 8) }, 201);
});

/* An installable app for the caretaker, opening straight on their link. */
route('GET', '/manifest/:token', async ({ params }) => {
  const contact = await caretaker(params.token);
  return new Response(JSON.stringify({
    name: `${contact.calls} · Messages`,
    short_name: contact.calls,
    start_url: `/c/${params.token}`,
    scope: `/c/${params.token}`,
    display: 'standalone',
    background_color: '#efece6',
    theme_color: '#efece6',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  }), { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' } });
});

/* ── push ────────────────────────────────────────────────────────────── */

route('GET', '/push/key', async () => json({ key: push.publicKey() }));

route('POST', '/push', async ({ req }) => {
  const d = await body(req);
  if (!d) throw new HttpError(400, 'invalid_subscription', 'Nothing to subscribe.');
  const who = await caller(req, d.token);
  const ok = await push.subscribe(who.slug, d.subscription);
  if (!ok) throw new HttpError(400, 'invalid_subscription', 'That subscription is not valid.');
  return json({ ok: true });
});

route('DELETE', '/push', async ({ req }) => {
  const d = (await body(req)) || {};
  const who = await caller(req, d.token);
  if (d.endpoint) await push.unsubscribe(who.slug, d.endpoint);
  return json({ ok: true });
});

/* ── calls ───────────────────────────────────────────────────────────── */

route('GET', '/ice', async ({ req, url }) => {
  await caller(req, url.searchParams.get('token'));
  return json({ iceServers: await calls.iceServers() });
});

route('GET', '/calls', async ({ req, url }) => {
  const who = await caller(req, url.searchParams.get('token'));
  let slug = who.slug;
  if (!slug && url.searchParams.get('slug')) {
    const contact = await messages.findContact(url.searchParams.get('slug'));
    if (!contact) throw new HttpError(404, 'contact_not_found', 'There is no contact by that name.');
    slug = contact.slug;
  }
  const since = (url.searchParams.get('since') || '').slice(0, 40);
  return json(await calls.poll(who.side, slug, since));
});

route('POST', '/calls', async ({ req }) => {
  const d = await body(req);
  if (!d) throw new HttpError(400, 'invalid_call', 'Nothing to do.');
  const who = await caller(req, d.token);
  const slug = who.slug || d.slug;
  const action = String(d.action || '').trim().toLowerCase();

  let call;
  if (action === 'start') call = await calls.place(slug, who.side);
  else if (action === 'answer') call = await calls.answer(slug, who.side);
  else if (action === 'end') call = await calls.end(slug, who.side, d.reason);
  else if (action === 'signal') call = await calls.signal(slug, who.side, d.kind, d.data);
  else throw new HttpError(400, 'invalid_call', 'Unknown call action.');
  return json({ call });
});

/* ── the orb ─────────────────────────────────────────────────────────── */

async function newsReply(kind, category, question) {
  const reply = (speak, extra = {}) => json({ action: 'news', question, speak, ...extra });

  if (kind === 'settings') {
    return json({ action: 'news-settings', question,
                  speak: "Here are your news settings. Pick the kinds of news you'd like to hear." });
  }
  if (kind === 'following') return reply(await news.followingLine());
  if (kind === 'more') {
    const story = await news.currentStory();
    return reply(news.storyLine(story), { story });
  }
  if (kind === 'next') {
    const story = await news.advance();
    if (!story) return reply(news.exhaustedLine());
    return reply(news.storyLine(story, 'Next story. '), { story });
  }
  if (kind === 'repeat') {
    const [found, readCategory] = await news.lastRead();
    return reply(news.headlinesLine(found.slice(0, news.HEADLINE_COUNT), readCategory), { category: readCategory });
  }

  let found;
  try {
    found = await news.stories(category ? [category] : null, kind === 'refresh');
  } catch {
    return json({ error: 'news', question,
                  speak: "I can't reach the news just now. Please try again in a moment." }, 502);
  }
  const top = found.slice(0, news.HEADLINE_COUNT);
  await news.beginReading(top, category);
  if (kind === 'open') return reply("Here's the news.", { category });
  return reply(news.headlinesLine(top, category), { category });
}

route('POST', '/ask', async ({ req, context }) => {
  auth.requireSenior(req);

  let form;
  try {
    form = await req.formData();
  } catch {
    return json({ error: 'no_audio', speak: "I didn't catch that. Please try again." }, 400);
  }
  const clip = form.get('audio');
  if (!clip || typeof clip === 'string') {
    return json({ error: 'no_audio', speak: "I didn't catch that. Please try again." }, 400);
  }
  if (clip.size > MAX_AUDIO_BYTES) {
    return json({ error: 'too_long', speak: 'That was a little long for me. Please ask a shorter question.' }, 413);
  }
  if (clip.size < 1024) return json({ error: 'empty', speak: "I didn't hear anything. Please try again." });

  // A dead microphone and a silent room need different advice.
  const peak = Number.parseFloat(form.get('peak'));
  if (Number.isFinite(peak) && peak < stt.SILENCE_PEAK) {
    return json({ error: 'no_signal', speak: "I can't hear your microphone. Please check that it is turned on." });
  }

  let question;
  try {
    question = await stt.transcribe(await clip.arrayBuffer(), clip.type);
  } catch (error) {
    console.error('transcription failed', error.message);
    const speak = error.message === 'rate limited'
      ? 'I need a short rest. Please try again in a few minutes.'
      : 'I had trouble hearing you. Please try again.';
    return json({ error: 'stt', speak }, 500);
  }
  console.log('heard:', JSON.stringify(question));
  if (!question) return json({ error: 'silence', speak: "I didn't hear a question. Please try again." });

  const game = intents.matchGame(question);
  if (game) return json({ action: 'game', game: game[0], question, speak: `Opening ${game[1]}.` });

  if (intents.matchWeather(question)) {
    try {
      const report = await weather.forecast(context);
      return json({ action: 'weather', weather: report, question, speak: report.speak });
    } catch {
      return json({ error: 'weather', question,
                    speak: "I can't get the forecast just now. Please try again in a moment." }, 502);
    }
  }

  const medora = intents.matchMedora(question);
  if (medora) {
    if (medora === 'test') return json({ action: 'medora-test', question, speak: 'Testing Medora now.' });
    const speak = medora === 'list' ? await medicines.upcomingDosesLine() : await medicines.nextDoseLine();
    return json({ action: 'medora', medora: await medicines.snapshot(), question, speak });
  }

  const heardNews = intents.matchNews(question);
  if (heardNews) {
    const [kind, category] = heardNews;
    // "tell me more" and friends only belong to the news while it is being read.
    if (!['more', 'next', 'repeat'].includes(kind) || await news.readingActive()) {
      return newsReply(kind, category, question);
    }
  }

  try {
    const { text, searched } = await brain.answer(question);
    console.log('said:', JSON.stringify(text), searched ? '(searched)' : '');
    return json({ question, speak: text, searched });
  } catch (error) {
    console.error('brain failed', error.message);
    const speak = error.message === 'rate limited'
      ? 'I need a short rest. Please try again in a few minutes.'
      : "I'm having trouble thinking right now. Please try again in a moment.";
    return json({ error: 'brain', question, speak }, 502);
  }
});

/* ── dispatch ────────────────────────────────────────────────────────── */

export default async (req, context) => {
  const url = new URL(req.url);
  const matches = routes.filter((r) => r.regex.test(url.pathname));
  if (!matches.length) return json({ error: 'not_found', message: 'No such route.' }, 404);
  const found = matches.find((r) => r.method === req.method);
  if (!found) return json({ error: 'method_not_allowed', message: 'Method not allowed.' }, 405);

  const values = found.regex.exec(url.pathname).slice(1).map(decodeURIComponent);
  const params = Object.fromEntries(found.keys.map((k, i) => [k, values[i]]));

  try {
    // Only the senior's own device sets the clock; a caretaker may be anywhere.
    const fromSenior = !url.pathname.startsWith('/api/c/') && auth.isSenior(req);
    await useTimezone(fromSenior ? req.headers.get('x-timezone') : null);
    return await found.handler({ req, context, url, params });
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.error, message: error.message }, error.status);
    }
    console.error(`${req.method} ${url.pathname} failed`, error);
    return json({ error: 'server', message: 'Something went wrong. Please try again.' }, 500);
  }
};
