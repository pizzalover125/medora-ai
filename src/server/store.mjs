/* Everything the app remembers, in one Netlify Blobs store.

   The Flask app kept a JSON file per feature beside it. A serverless function
   has no disk that outlives the request, so each of those files is a key
   here instead. Writes that read first go through update(), which retries on
   a conflicting write rather than letting the later one silently win - two
   people texting at once is the normal case, not the edge one. */

import { getStore } from '@netlify/blobs';

/* A fresh handle every time, never a cached one. getStore() picks up the
   access token of the request it is called in, and a warm function serves
   many requests: a handle kept from the first one outlives its token, and
   every request after that fails with "Token expired". */
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

/* Keys under a prefix, in key order. */
export async function keys(prefix) {
  const { blobs } = await db().list({ prefix });
  return blobs.map((b) => b.key).sort();
}

export async function remove(key) {
  await db().delete(key);
}

/* Read, change, write - and start over if someone else wrote in between.

   Only for keys that one person changes at a time - the calendar, the
   schedule, the call's state. Blobs' conditional writes are not reliable
   under real contention (tested: ten simultaneous writers lose some), so
   anything two people write at once - messages, call signals, push
   subscriptions - is one key per record instead, and never rewritten.

   `change` mutates the value it is given (or returns a replacement in
   `{replace}`) and returns whatever the caller wants back. Returning
   update.SKIP leaves the stored value alone. */
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
