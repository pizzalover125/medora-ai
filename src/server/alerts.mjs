/* Telling caretakers when a dose goes unanswered.

   Every five minutes (netlify/functions/dose-check.mjs) this looks for doses
   whose grace period has run out with nothing recorded - not taken on the
   dispenser, not taken or skipped in the app - and pushes a notification to
   each caretaker the senior has allowed to know ("doses" in their link
   panel). Each missed time is told about once: an `alerted/` key is written
   before anyone is notified, and old ones are swept away after two days.

   Only the last hour is looked at, so turning this on - or a deploy - never
   unearths a backlog of old doses. */

import { localMinute } from './clock.mjs';
import * as medicines from './medicines.mjs';
import * as messages from './messages.mjs';
import * as push from './push.mjs';
import { keys, read, remove, write } from './store.mjs';

const WINDOW_MINUTES = 60;
const FORGET_AFTER_MINUTES = 2 * 24 * 60;

const doseText = (d) => (d.quantity > 1 ? `${d.quantity} ${d.name}` : d.name);
const list = (parts) => (parts.length === 1 ? parts[0]
  : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

export async function checkMissedDoses() {
  const watchers = (await messages.contacts()).filter((c) => c.permissions.doses);
  const missed = await medicines.missedDoses(WINDOW_MINUTES);

  // Doses due at the same minute are one alert, not one per pill.
  const byMinute = new Map();
  for (const dose of missed) {
    if (!byMinute.has(dose.minute)) byMinute.set(dose.minute, []);
    byMinute.get(dose.minute).push(dose);
  }

  const sent = [];
  for (const [minute, doses] of byMinute) {
    const key = `alerted/${minute}`;
    if (await read(key, null)) continue;
    await write(key, { at: Date.now(), containers: doses.map((d) => d.container) });
    if (!watchers.length) continue;

    const time = medicines.spokenDoseTime(minute);
    const what = list(doses.map(doseText));
    await Promise.all(watchers.map((contact) => push.notify(contact.slug, {
      kind: 'dose',
      slug: contact.slug,
      title: `${contact.calls}'s ${time} dose isn't marked taken`,
      body: `${what} was due at ${time}, and Medora hasn't recorded it yet. ` +
            `Maybe give ${contact.calls} a call.`,
      tag: `dose-${minute}`,
    }, { urgent: true, ttl: 6 * 3600 })));
    sent.push({ minute, what, to: watchers.map((c) => c.slug) });
  }

  // Sweep alert markers too old to matter.
  const cutoff = localMinute() - FORGET_AFTER_MINUTES;
  const stale = (await keys('alerted/')).filter((k) => Number(k.split('/')[1]) < cutoff);
  await Promise.all(stale.map((k) => remove(k)));

  return { checked: missed.length, sent };
}
