import crypto from 'node:crypto';
import { HttpError, read, update } from './store.mjs';

const KEY = 'events';

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'create_event',
      description:
        'Add something to the person\'s calendar - an appointment, reminder, birthday, or ' +
        'anything else tied to a date. Use it whenever they ask you to remember, add, book, ' +
        'or set something for a date or time.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short description, e.g. "Doctor\'s appointment" or "Call Mary".' },
          date: {
            type: 'string',
            description: 'The event\'s date as YYYY-MM-DD. Work out relative dates ("next Tuesday", ' +
              '"tomorrow") yourself from today\'s date first - never ask the person to repeat it ' +
              'in a different format.',
          },
          time: { type: 'string', description: 'The event\'s time as 24-hour HH:MM, if one was given. Omit for an all-day event.' },
        },
        required: ['title', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_events',
      description:
        'Look up what is on the person\'s calendar. Use it for anything asking what they have ' +
        'coming up, what is on a given day, or whether something is already scheduled - and ' +
        'before changing or cancelling an event whose id you do not already have from earlier ' +
        'in this conversation.',
      parameters: {
        type: 'object',
        properties: {
          from_date: { type: 'string', description: 'Start of the range, YYYY-MM-DD. Defaults to today.' },
          to_date: { type: 'string', description: 'End of the range, YYYY-MM-DD, inclusive. Omit for an open-ended upcoming search.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_event',
      description: 'Change an existing event\'s title, date, or time. Call list_events first if you do not already know its id.',
      parameters: {
        type: 'object',
        properties: {
          event_id: { type: 'string' },
          title: { type: 'string' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          time: { type: 'string', description: '24-hour HH:MM, or an empty string to clear a time that was set.' },
        },
        required: ['event_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_event',
      description:
        'Remove an event from the calendar because the person cancelled it or asked you to ' +
        'forget it. Call list_events first if you do not already know its id.',
      parameters: {
        type: 'object',
        properties: { event_id: { type: 'string' } },
        required: ['event_id'],
      },
    },
  },
];

export const NAMES = new Set(TOOLS.map((t) => t.function.name));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function validDate(s) {
  if (!s || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const sortKey = (e) => `${e.date} ${e.time || '99:99'}`;
const byKey = (a, b) => sortKey(a).localeCompare(sortKey(b));
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const invalid = (message) => new HttpError(400, 'invalid_event', message);
const missing = () => new HttpError(404, 'event_not_found', 'That event no longer exists.');

export async function listAll() {
  return [...(await read(KEY, []))].sort(byKey);
}

function cleanTitle(title) {
  title = text(title);
  if (!title) throw invalid('Please give the event a title.');
  if (title.length > 160) throw invalid('Please keep the event title under 160 characters.');
  return title;
}

export async function createEvent(title, date, time, by = null) {
  title = cleanTitle(title);
  date = text(date);
  time = text(time) || null;
  if (!validDate(date)) throw invalid('Please choose a valid date.');
  if (time && !TIME_RE.test(time)) throw invalid('Please choose a valid time.');

  const event = { id: crypto.randomBytes(4).toString('hex'), title, date, time };
  if (by) event.by = String(by).slice(0, 40);
  await update(KEY, [], (items) => { items.push(event); });
  return { ...event };
}

export async function updateEvent(eventId, changes) {
  eventId = text(eventId);
  const cleaned = {};
  if ('title' in changes) cleaned.title = cleanTitle(changes.title);
  if ('date' in changes) {
    cleaned.date = text(changes.date);
    if (!validDate(cleaned.date)) throw invalid('Please choose a valid date.');
  }
  if ('time' in changes) {
    cleaned.time = text(changes.time) || null;
    if (cleaned.time && !TIME_RE.test(cleaned.time)) throw invalid('Please choose a valid time.');
  }
  if (!Object.keys(cleaned).length) throw invalid('There are no changes to save.');

  return update(KEY, [], (items) => {
    const event = items.find((e) => e.id === eventId);
    if (!event) throw missing();
    Object.assign(event, cleaned);
    return { ...event };
  });
}

export async function deleteEvent(eventId) {
  eventId = text(eventId);
  return update(KEY, [], (items) => {
    const event = items.find((e) => e.id === eventId);
    if (!event) throw missing();
    return update.replace(items.filter((e) => e.id !== eventId), { ...event });
  });
}

const when = (e) => (e.time ? `${e.date} at ${e.time}` : e.date);

export async function call(name, args) {
  try {
    if (name === 'create_event') {
      const e = await createEvent(args.title, args.date, args.time);
      return `Created (id ${e.id}): '${e.title}' on ${when(e)}.`;
    }
    if (name === 'list_events') {
      const from = text(args.from_date);
      const to = text(args.to_date);
      if (from && !validDate(from)) return 'from_date must be YYYY-MM-DD.';
      if (to && !validDate(to)) return 'to_date must be YYYY-MM-DD.';
      const found = (await listAll()).filter((e) => (!from || e.date >= from) && (!to || e.date <= to));
      if (!found.length) return 'No events found in that range.';
      return found.map((e) => `id ${e.id}: ${e.title} on ${when(e)}`).join('\n');
    }
    if (name === 'update_event' || name === 'delete_event') {
      const id = text(args.event_id);
      if (!id) return 'No event id was given.';
      if (name === 'delete_event') {
        const e = await deleteEvent(id);
        return `Deleted: '${e.title}'.`;
      }
      const changes = {};
      if (text(args.title)) changes.title = args.title;
      if (text(args.date)) changes.date = args.date;
      if ('time' in args) changes.time = args.time;
      if (!Object.keys(changes).length) return 'No changes were given for the event.';
      const e = await updateEvent(id, changes);
      return `Updated: '${e.title}' now on ${when(e)}.`;
    }
  } catch (error) {
    if (error.error === 'event_not_found') {
      return `No event with id '${args.event_id}'. Call list_events to find the right id.`;
    }
    if (error instanceof HttpError) return error.message;
    throw error;
  }
  return 'Unknown calendar action.';
}
