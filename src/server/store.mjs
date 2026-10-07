import { getStore } from '@netlify/blobs';

const db = () => getStore({ name: 'medora', consistency: 'strong' });

export class HttpError extends Error {
  constructor(status, error, message) {
    super(message);
    this.status = status;
    this.error = error;
  }
}

export async function read(key, fallback) {
  const value = await db().get(key, { type: 'json' });
  return value ?? (typeof fallback === 'function' ? fallback() : fallback);
}

export async function write(key, value) {
  await db().setJSON(key, value);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function keys(prefix) {
  const { blobs } = await db().list({ prefix });
  return blobs.map((b) => b.key).sort();
}

export async function remove(key) {
  await db().delete(key);
}

export async function update(key, fallback, change) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const entry = await db().getWithMetadata(key, { type: 'json' });
    let value = entry && entry.data != null
      ? entry.data
      : (typeof fallback === 'function' ? fallback() : structuredClone(fallback));

    const out = await change(value);
    if (out === update.SKIP) return undefined;
    if (out && out[REPLACE]) value = out[REPLACE];

    const options = entry ? { onlyIfMatch: entry.etag } : { onlyIfNew: true };
    const { modified } = await db().setJSON(key, value, options);
    if (modified) return out && out[REPLACE] ? out.result : out;

    await sleep(15 + Math.random() * 40 * (attempt + 1));
  }
  throw new HttpError(503, 'busy', 'That is taking longer than it should. Please try again.');
}

const REPLACE = Symbol('replace');
update.SKIP = Symbol('skip');
update.replace = (value, result) => ({ [REPLACE]: value, result });
