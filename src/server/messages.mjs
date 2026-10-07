import crypto from 'node:crypto';
import { newToken } from './auth.mjs';
import { HttpError, keys, read, remove, update, write } from './store.mjs';

export const SENIOR = 'senior';
export const CONTACT = 'contact';
export const SENDERS = [SENIOR, CONTACT];
const MAX_TEXT = 600;
const MAX_SHOWN = 300;
const MAX_CONTACTS = 24;

const SEED_CONTACTS = [
  { slug: 'son', name: 'Michael', relation: 'Son', calls: 'Dad' },
  { slug: 'daughter', name: 'Sarah', relation: 'Daughter', calls: 'Dad' },
  { slug: 'grandson', name: 'Danny', relation: 'Grandson', calls: 'Grandpa' },
  { slug: 'granddaughter', name: 'Emily', relation: 'Granddaughter', calls: 'Grandpa' },
  { slug: 'nephew', name: 'Robert', relation: 'Nephew', calls: 'Uncle George' },
  { slug: 'doctor', name: 'Dr. Patel', relation: 'Doctor', calls: 'George' },
];

const SEED = {
  son: [
    [CONTACT, 430, 'Morning Dad! Did you sleep any better last night?', true],
    [SENIOR, 421, 'Much better, thank you. The new pillow helps.', true],
    [CONTACT, 24, "Good. I'll bring the groceries over after work.", false],
  ],
  daughter: [
    [CONTACT, 1490, 'Hi Dad - the pharmacy called, your refill is ready.', true],
    [SENIOR, 1483, "Thank you, love. I'll ask Michael to collect it.", true],
  ],
  grandson: [
    [CONTACT, 96, 'Hi Grandpa! Are we still on for Sunday?', true],
    [SENIOR, 91, "Of course we are. I'll make the lemon cake.", true],
    [CONTACT, 7, 'Perfect. Can I bring a friend from school?', false],
  ],
  granddaughter: [
    [CONTACT, 2890, 'Grandpa, look what I painted in art class today!', true],
    [SENIOR, 2874, "It's beautiful. It's going straight on the fridge.", true],
  ],
  nephew: [
    [CONTACT, 1610, 'Hi Uncle George, how did the eye appointment go?', true],
    [SENIOR, 1602, 'All clear. New glasses in two weeks.', true],
  ],
  doctor: [
    [CONTACT, 640, 'Reminder: your check-up is Thursday at 10:00. ' +
                   'Please bring your list of medications.', true],
    [SENIOR, 628, 'Thank you, I have it on my calendar.', true],
  ],
};

const iso = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', '+00:00');
const stamp = (ms) => String(ms).padStart(14, '0');
const other = (side) => (side === SENIOR ? CONTACT : SENIOR);

async function seed() {
  const contacts = SEED_CONTACTS.map((c) => ({ ...c, token: newToken() }));
  const book = await update('contacts', () => null, (current) =>
    (current ? update.SKIP : update.replace({ contacts }, { contacts })));
  if (!book) return (await read('contacts', null)) || { contacts };

  const now = Math.floor(Date.now() / 60000) * 60000;
  await Promise.all(Object.entries(SEED).flatMap(([slug, lines]) => {
    const writes = lines.map(([from, ago, text]) =>
      putMessage(slug, from, text, now - ago * 60000, 'text', `seed${ago}`));
    for (const side of SENDERS) {
      const seen = lines.filter(([from, , , wasRead]) => from !== side && wasRead)
        .map(([, ago]) => now - ago * 60000);
      if (seen.length) writes.push(write(`read/${slug}/${side}`, Math.max(...seen)));
    }
    return writes;
  }));
  return book;
}

async function book() {
  return (await read('contacts', null)) || seed();
}

export const publicContact = ({ token, ...rest }) => rest;

export const PERMISSIONS = ['doses', 'day'];
const withPermissions = (contact) => ({
  ...contact,
  permissions: Object.fromEntries(PERMISSIONS.map((p) => [p, !!contact.permissions?.[p]])),
});

export async function contacts() {
  return (await book()).contacts.map(withPermissions);
}

export async function findContact(slug) {
  const key = (slug || '').trim().toLowerCase();
  return (await contacts()).find((c) => c.slug === key) || null;
}

export async function contactByToken(token) {
  if (!token || typeof token !== 'string' || token.length < 16) return null;
  return (await contacts()).find((c) => c.token === token) || null;
}

async function requireContact(slug) {
  const contact = await findContact(slug);
  if (!contact) throw new HttpError(404, 'contact_not_found', 'There is no contact by that name.');
  return contact;
}

function parseKey(key) {
  const [, slug, rest] = key.split('/');
  const [ms, from, id] = rest.split('-');
  return { key, slug, ms: Number(ms), from, id };
}

async function putMessage(slug, from, text, ms = Date.now(), kind = 'text', id = null) {
  id = id || crypto.randomBytes(4).toString('hex');
  const message = { id, from, text, at: iso(ms), kind };
  await write(`msg/${slug}/${stamp(ms)}-${from}-${id}`, message);
  return { ...message, ms };
}

async function readMark(slug, side) {
  return Number(await read(`read/${slug}/${side}`, 0)) || 0;
}

const isUnread = (entry, viewer, mark) => entry.from === other(viewer) && entry.ms > mark;

export async function overview(viewer = SENIOR) {
  const people = await contacts();
  const all = (await keys('msg/')).map(parseKey);

  const cards = await Promise.all(people.map(async (contact) => {
    const mine = all.filter((m) => m.slug === contact.slug);
    const newest = mine[mine.length - 1];
    const [mark, last] = await Promise.all([
      readMark(contact.slug, viewer),
      newest ? read(newest.key, null) : null,
    ]);
    return {
      ...publicContact(contact),
      last: last ? { ...last, read: !isUnread(newest, viewer, mark) } : null,
      unread: mine.filter((m) => isUnread(m, viewer, mark)).length,
    };
  }));

  cards.sort((a, b) => (b.last?.at || '').localeCompare(a.last?.at || ''));
  return cards;
}

export async function thread(slug, viewer) {
  const contact = await requireContact(slug);
  const entries = (await keys(`msg/${contact.slug}/`)).map(parseKey).slice(-MAX_SHOWN);
  const [bodies, mark, theirMark] = await Promise.all([
    Promise.all(entries.map((e) => read(e.key, null))),
    readMark(contact.slug, viewer),
    readMark(contact.slug, other(viewer)),
  ]);

  const newest = entries.length ? entries[entries.length - 1].ms : 0;
  if (SENDERS.includes(viewer) && newest > mark) {
    await write(`read/${contact.slug}/${viewer}`, newest);
  }

  return entries.map((e, i) => (bodies[i]
    ? { ...bodies[i], read: e.from === viewer ? e.ms <= theirMark : true }
    : null)).filter(Boolean);
}

export async function send(slug, sender, text) {
  if (!SENDERS.includes(sender)) {
    throw new HttpError(400, 'invalid_message', 'A message needs a sender.');
  }
  text = typeof text === 'string' ? text.trim() : '';
  if (!text) throw new HttpError(400, 'invalid_message', 'Please write a message first.');
  if (text.length > MAX_TEXT) {
    throw new HttpError(400, 'invalid_message', `Please keep messages under ${MAX_TEXT} characters.`);
  }

  const contact = await requireContact(slug);
  const { ms, ...message } = await putMessage(contact.slug, sender, text);
  await write(`read/${contact.slug}/${sender}`, ms);
  return { message: { ...message, read: false }, contact: publicContact(contact) };
}

export async function logNote(slug, sender, text) {
  const contact = await requireContact(slug);
  const { ms, ...note } = await putMessage(contact.slug, sender, text.trim(), Date.now(), 'note');
  await write(`read/${contact.slug}/${sender}`, ms);
  return { ...note, read: false };
}

export async function logEvent(slug, sender, text, { read: wasRead = true, at = Date.now(), id } = {}) {
  const contact = await findContact(slug);
  if (!contact) return null;
  const { ms, ...event } = await putMessage(contact.slug, sender, text.trim(), at, 'call', id);
  if (wasRead) {
    const mark = await readMark(contact.slug, other(sender));
    if (ms > mark) await write(`read/${contact.slug}/${other(sender)}`, ms);
  }
  return event;
}

function clean(value, max, what) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!text) throw new HttpError(400, 'invalid_contact', `Please give ${what}.`);
  if (text.length > max) {
    throw new HttpError(400, 'invalid_contact', `Please keep ${what} under ${max} characters.`);
  }
  return text;
}

function slugFor(name, taken) {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 24) || 'contact';
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  return slug;
}

const changeBook = async (fn) => {
  await book();
  return update('contacts', () => ({ contacts: [] }), fn);
};

function requireIn(store, slug) {
  const contact = store.contacts.find((c) => c.slug === (slug || '').trim().toLowerCase());
  if (!contact) throw new HttpError(404, 'contact_not_found', 'There is no contact by that name.');
  return contact;
}

export async function addContact({ name, relation, calls }) {
  name = clean(name, 40, 'their name');
  relation = clean(relation || 'Family', 30, 'how they know you');
  calls = clean(calls || 'Grandpa', 30, 'what they call you');

  return changeBook((store) => {
    if (store.contacts.length >= MAX_CONTACTS) {
      throw new HttpError(400, 'invalid_contact', 'That is as many people as Messages can hold.');
    }
    const taken = new Set([...store.contacts.map((c) => c.slug), ...(store.retired || [])]);
    const contact = { slug: slugFor(name, taken), name, relation, calls, token: newToken() };
    store.contacts.push(contact);
    return withPermissions(contact);
  });
}

export async function removeContact(slug) {
  const removed = await changeBook((store) => {
    const contact = requireIn(store, slug);
    store.contacts = store.contacts.filter((c) => c.slug !== contact.slug);
    store.retired = [...(store.retired || []), contact.slug];
    return publicContact(contact);
  });
  const stale = [...await keys(`msg/${removed.slug}/`), ...await keys(`read/${removed.slug}/`)];
  await Promise.all(stale.map((key) => remove(key)));
  return removed;
}

export async function setPermissions(slug, changes) {
  return changeBook((store) => {
    const contact = requireIn(store, slug);
    const next = withPermissions(contact).permissions;
    for (const key of PERMISSIONS) {
      if (typeof changes?.[key] === 'boolean') next[key] = changes[key];
    }
    contact.permissions = next;
    return publicContact(withPermissions(contact));
  });
}

export async function rotateToken(slug) {
  return changeBook((store) => {
    const contact = requireIn(store, slug);
    contact.token = newToken();
    return withPermissions(contact);
  });
}

export async function tokenFor(slug) {
  return requireContact(slug);
}
