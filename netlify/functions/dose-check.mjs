import { checkMissedDoses } from '../../src/server/alerts.mjs';
import { useTimezone } from '../../src/server/clock.mjs';

export const config = { schedule: '*/5 * * * *' };

export default async () => {
  await useTimezone(null);
  const result = await checkMissedDoses();
  if (result.sent.length) console.log('missed-dose alerts', JSON.stringify(result.sent));
  return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
};
