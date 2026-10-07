import crypto from 'node:crypto';
import { DAY_NAMES, MONTH_NAMES, hhmm, isoDate, localMinute, minuteToWall, wallNow } from './clock.mjs';
import { HttpError, read, update } from './store.mjs';

const KEY = 'medicines';
const blank = () => ({ medicines: [], doses: [] });

const CONTAINERS = [1, 2, 3, 4, 5];
const MAX_TIMES = 3;
const MAX_QUANTITY = 10;
export const GRACE_MINUTES = 5;
const SEARCH_DAYS = 62;
const HISTORY_DAYS = 30;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_medicines',
      description:
        'Look up everything Medora is holding - each medicine, when it is taken, and which ' +
        'container it is in. Use it for any question about what they are taking, and before ' +
        'changing or removing a medicine whose id you do not already have.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'next_dose',
      description:
        'What the person has to take next, and whether a dose is due right now. Use it for ' +
        '"what do I take next", "is anything due", or "when is my next pill".',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];
export const NAMES = new Set(TOOLS.map((t) => t.function.name));

const invalid = (message) => new HttpError(400, 'invalid_medicine', message);

async function load() {
  const stored = await read(KEY, blank);
  return { medicines: stored.medicines || [], doses: stored.doses || [] };
}

function prune(store) {
  const cutoff = localMinute() - HISTORY_DAYS * 24 * 60;
  store.doses = store.doses.filter((d) => d.minute >= cutoff);
}

const doseKey = (container, minute) => `${container}:${minute}`;
const sortMedicines = (list) => [...list].sort((a, b) =>
  a.container - b.container || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

function occurrences(store, days = SEARCH_DAYS, fromDay = 0) {
  const now = wallNow();
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) +
    fromDay * 86400000;
  const found = [];
  for (const medicine of store.medicines) {
    for (let offset = 0; offset < days; offset++) {
      const day = new Date(start + offset * 86400000);
      if (!medicine.days.includes(day.getUTCDay())) continue;
      for (const value of medicine.times) {
        const [h, m] = value.split(':').map(Number);
        const at = new Date(day.getTime() + (h * 60 + m) * 60000);
        found.push({
          medicine_id: medicine.id,
          name: medicine.name,
          quantity: medicine.quantity,
          container: medicine.container,
          minute: localMinute(at),
          date: isoDate(at),
          time: hhmm(at),
          at,
        });
      }
    }
  }
  found.sort((a, b) => a.minute - b.minute || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return found;
}

function unanswered(store) {
  const resolved = new Set(store.doses.map((d) => doseKey(d.container, d.minute)));
  const earliest = localMinute() - GRACE_MINUTES;
  return occurrences(store).filter((d) =>
    d.minute >= earliest && !resolved.has(doseKey(d.container, d.minute)));
}

const shown = ({ at, ...rest }) => rest;

export async function snapshot() {
  const store = await load();
  return {
    medicines: sortMedicines(store.medicines),
    doses: store.doses,
    upcoming: unanswered(store).slice(0, 3).map(shown),
  };
}

export async function dueNow() {
  const now = localMinute();
  const store = await load();
  return unanswered(store).filter((d) => now - GRACE_MINUTES <= d.minute && d.minute <= now).map(shown);
}

export async function missedDoses(windowMinutes = 60) {
  const now = localMinute();
  const store = await load();
  const resolved = new Set(store.doses.map((d) => doseKey(d.container, d.minute)));
  return occurrences(store, 2, -1)
    .filter((d) => d.minute < now - GRACE_MINUTES && d.minute >= now - windowMinutes &&
                   !resolved.has(doseKey(d.container, d.minute)))
    .map(shown);
}

export async function todayDoses() {
  const now = localMinute();
  const store = await load();
  const resolved = new Map(store.doses.map((d) => [doseKey(d.container, d.minute), d.status]));
  return occurrences(store, 1).map((dose) => {
    const answer = resolved.get(doseKey(dose.container, dose.minute));
    let status;
    if (answer === 'T') status = 'taken';
    else if (answer === 'S') status = 'skipped';
    else if (dose.minute > now) status = 'upcoming';
    else if (dose.minute >= now - GRACE_MINUTES) status = 'due';
    else status = 'missed';
    return { ...shown(dose), status };
  });
}

export const spokenDoseTime = (minute) => spokenTime(minuteToWall(minute));

const text = (v) => (typeof v === 'string' ? v.trim() : '');

function cleanTimes(values) {
  if (typeof values === 'string') values = [values];
  if (!Array.isArray(values) || !values.length) throw invalid('Please choose a time for every dose.');
  const times = values.map((v) => {
    const t = text(v);
    if (!TIME_RE.test(t)) throw invalid('Please give each dose time as a 24-hour time, like 09:00.');
    return t;
  });
  if (new Set(times).size !== times.length) throw invalid('Each dose needs a different time.');
  if (times.length > MAX_TIMES) throw invalid(`Medora can hold up to ${MAX_TIMES} doses a day for one medicine.`);
  return times.sort();
}

function cleanDays(values) {
  if (values == null) return [0, 1, 2, 3, 4, 5, 6];
  if (!Array.isArray(values)) values = [values];
  const days = new Set();
  for (const value of values) {
    const day = Number.parseInt(value, 10);
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      throw invalid('Days run from 0 for Sunday to 6 for Saturday.');
    }
    days.add(day);
  }
  if (!days.size) throw invalid('Please choose at least one day.');
  return [...days].sort((a, b) => a - b);
}

function cleanQuantity(value) {
  if (value == null || value === '') return 1;
  const quantity = Number(value);
  if (!Number.isInteger(quantity)) throw invalid('Please give the number to take as a whole number.');
  if (quantity < 1 || quantity > MAX_QUANTITY) throw invalid(`A dose can be from 1 to ${MAX_QUANTITY} at a time.`);
  return quantity;
}

function cleanContainer(value, taken) {
  const free = CONTAINERS.filter((c) => !taken.has(c));
  if (!free.length) {
    throw invalid("All five of Medora's containers are in use. Remove a medicine to free one.");
  }
  if (value == null || value === '') return free[0];
  const container = Number(value);
  if (!Number.isInteger(container)) throw invalid('Please choose an available container.');
  if (!CONTAINERS.includes(container)) throw invalid("Medora's containers are numbered 1 to 5.");
  if (taken.has(container)) throw invalid(`Container ${container} is already in use.`);
  return container;
}

export async function createMedicine(name, times, days, quantity, container) {
  name = text(name).replace(/\s+/g, ' ');
  if (!name) throw invalid('Please give the medicine a name.');
  if (name.length > 80) throw invalid('Please keep the name under 80 characters.');
  times = cleanTimes(times);
  days = cleanDays(days);
  quantity = cleanQuantity(quantity);

  return update(KEY, blank, (store) => {
    store.medicines ||= [];
    store.doses ||= [];
    const taken = new Set(store.medicines.map((m) => m.container));
    const medicine = {
      id: crypto.randomBytes(4).toString('hex'),
      name, quantity, container: cleanContainer(container, taken), days, times,
    };
    store.medicines.push(medicine);
    prune(store);
    return { ...medicine };
  });
}

export async function deleteMedicine(id) {
  id = text(id);
  return update(KEY, blank, (store) => {
    const medicine = (store.medicines || []).find((m) => m.id === id);
    if (!medicine) throw new HttpError(404, 'medicine_not_found', 'That medicine is no longer in Medora.');
    store.medicines = store.medicines.filter((m) => m.id !== id);
    store.doses ||= [];
    prune(store);
    return { ...medicine };
  });
}

export async function recordDoseResult(container, minute, status) {
  container = Number(container);
  minute = Number(minute);
  if (!Number.isInteger(container) || !Number.isInteger(minute)) {
    throw new HttpError(400, 'invalid_dose', 'That dose could not be identified.');
  }
  status = (text(status).toUpperCase()[0]) || 'T';
  if (!CONTAINERS.includes(container)) throw new HttpError(400, 'invalid_dose', "Medora's containers are numbered 1 to 5.");
  if (!['T', 'S'].includes(status)) throw new HttpError(400, 'invalid_dose', 'A dose is either taken or skipped.');

  const dose = { container, minute, status };
  await update(KEY, blank, (store) => {
    store.medicines ||= [];
    store.doses = (store.doses || []).filter((d) => !(d.container === container && d.minute === minute));
    store.doses.push(dose);
    prune(store);
  });
  return { ...dose };
}

function spokenTime(at) {
  const hour = at.getUTCHours();
  const minute = at.getUTCMinutes();
  return `${hour % 12 || 12}${minute ? `:${String(minute).padStart(2, '0')}` : ''} ${hour < 12 ? 'AM' : 'PM'}`;
}

function spokenDay(at) {
  const now = wallNow();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const that = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  const days = Math.round((that - today) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 7) return `on ${DAY_NAMES[at.getUTCDay()]}`;
  return `on ${MONTH_NAMES[at.getUTCMonth()]} ${at.getUTCDate()}`;
}

const spokenDose = (d) => (d.quantity > 1 ? `${d.quantity} ${d.name}` : `your ${d.name}`);
const spokenList = (parts) => (parts.length === 1 ? parts[0]
  : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);
const sentence = (t) => t[0].toUpperCase() + t.slice(1);
const COUNT_WORDS = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five' };
const EMPTY = "You haven't added any medicines yet. You can add one in Medora.";

export async function nextDoseLine() {
  const store = await load();
  if (!store.medicines.length) return EMPTY;
  const pending = unanswered(store);
  if (!pending.length) return 'Nothing is due. Medora has no more doses scheduled.';

  const now = localMinute();
  const due = pending.filter((d) => d.minute <= now);
  if (due.length) {
    return `It's time for ${spokenList(due.map(spokenDose))}. Press taken on Medora when you have.`;
  }
  const first = pending[0];
  const together = pending.filter((d) => d.minute === first.minute);
  return `Your next dose is ${spokenList(together.map(spokenDose))}, ` +
         `${spokenDay(first.at)} at ${spokenTime(first.at)}.`;
}

export async function upcomingDosesLine(limit = 3) {
  const store = await load();
  if (!store.medicines.length) return EMPTY;
  const pending = unanswered(store);
  if (!pending.length) return 'Nothing is coming up. Medora has no more doses scheduled.';

  const now = localMinute();
  const parts = pending.slice(0, limit).map((d, i) => {
    const when = d.minute <= now ? 'due now' : `${spokenDay(d.at)} at ${spokenTime(d.at)}`;
    return sentence(`${i ? 'then ' : ''}${spokenDose(d)}, ${when}.`);
  });
  if (parts.length === 1) return `Just one dose is coming up. ${parts[0]}`;
  return [`You have ${COUNT_WORDS[parts.length] || parts.length} doses coming up.`, ...parts].join(' ');
}

function describeSchedule(m) {
  const times = m.times.map((v) => {
    const [h, mm] = v.split(':').map(Number);
    return spokenTime(new Date(Date.UTC(2000, 0, 1, h, mm)));
  }).join(', ');
  const days = m.days.length === 7 ? 'every day' : m.days.map((d) => DAY_NAMES[d]).join(', ');
  return `${m.quantity} at ${times}, ${days}`;
}

export async function call(name) {
  const store = await load();
  if (name === 'list_medicines') {
    if (!store.medicines.length) return 'Medora is empty - no medicines have been added yet.';
    return sortMedicines(store.medicines)
      .map((m) => `id ${m.id}: ${m.name}, container ${m.container}, ${describeSchedule(m)}`).join('\n');
  }
  if (name === 'next_dose') {
    if (!store.medicines.length) return 'Medora is empty - no medicines have been added yet.';
    const pending = unanswered(store);
    if (!pending.length) return 'Nothing is scheduled from here on.';
    const now = localMinute();
    return pending.slice(0, 4).map((d) => {
      const late = now - d.minute;
      const when = late >= 0 && late <= GRACE_MINUTES ? 'due now' : `${spokenDay(d.at)} at ${spokenTime(d.at)}`;
      return `${d.quantity} x ${d.name} (container ${d.container}): ${when}`;
    }).join('\n');
  }
  return 'Unknown medicine action.';
}

export { minuteToWall };
