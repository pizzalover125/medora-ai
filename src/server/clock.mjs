/* The senior's wall clock.

   A function runs in UTC, wherever the senior is. The schedule, the calendar
   and "today's date" are all about the clock on the senior's wall, so every
   request from their page carries its IANA time zone (X-Timezone, see
   static/session.js) and the last one seen is kept for requests that arrive
   without one.

   Times here are "wall milliseconds": the senior's local date and time
   written as if it were UTC. Read them back with the getUTC* methods. That is
   the same trick the dispenser uses - minutes since 1970 in local time - so
   nothing downstream has to know about offsets. */

import { read, write } from './store.mjs';

let current = 'UTC';

function valid(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/* Called once per request, before anything reads the clock. */
export async function useTimezone(header) {
  const settings = await read('settings', {});
  const stored = valid(settings.tz) ? settings.tz : null;
  const sent = header && valid(header) ? header : null;

  current = sent || stored || 'UTC';
  if (sent && sent !== stored) {
    await write('settings', { ...settings, tz: sent });
  }
  return current;
}

export const timezone = () => current;

export function wallNow(date = new Date(), tz = current) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day,
                           +parts.hour % 24, +parts.minute, +parts.second));
}

export const localMinute = (wall = wallNow()) => Math.floor(wall.getTime() / 60000);
export const minuteToWall = (minute) => new Date(minute * 60000);

export const isoDate = (wall) => wall.toISOString().slice(0, 10);
export const hhmm = (wall) => wall.toISOString().slice(11, 16);

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday',
                          'Friday', 'Saturday'];
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                            'August', 'September', 'October', 'November', 'December'];

/* "Saturday, 03 October 2026" - what the model is told today is. */
export function longToday(wall = wallNow()) {
  const day = String(wall.getUTCDate()).padStart(2, '0');
  return `${DAY_NAMES[wall.getUTCDay()]}, ${day} ${MONTH_NAMES[wall.getUTCMonth()]} ` +
         `${wall.getUTCFullYear()}`;
}
