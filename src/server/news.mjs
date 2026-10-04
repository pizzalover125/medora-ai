/* The news, answered without the model.

   Headlines come from the outlets' own RSS feeds - no key, no account. Every
   section is read from two outlets so one of them being down does not empty
   the app. Only headlines are read aloud, three at a time. */

import crypto from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { HttpError, read, update } from './store.mjs';

const TTL = 10 * 60 * 1000;
const MAX_PER_FEED = 8;
export const HEADLINE_COUNT = 3;
const SUMMARY_CHARS = 320;
const READING_TTL = 15 * 60 * 1000;

export const CATEGORIES = [
  { key: 'world', label: 'World', spoken: 'world news',
    feeds: ['https://feeds.npr.org/1004/rss.xml', 'https://feeds.bbci.co.uk/news/world/rss.xml'] },
  { key: 'nation', label: 'National', spoken: 'national news',
    feeds: ['https://feeds.npr.org/1003/rss.xml', 'https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml'] },
  { key: 'business', label: 'Business', spoken: 'business news',
    feeds: ['https://feeds.npr.org/1006/rss.xml', 'https://feeds.bbci.co.uk/news/business/rss.xml'] },
  { key: 'health', label: 'Health', spoken: 'health news',
    feeds: ['https://feeds.npr.org/1128/rss.xml', 'https://feeds.bbci.co.uk/news/health/rss.xml'] },
  { key: 'science', label: 'Science', spoken: 'science news',
    feeds: ['https://feeds.npr.org/1007/rss.xml', 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml'] },
  { key: 'sports', label: 'Sports', spoken: 'sports news',
    feeds: ['https://feeds.npr.org/1055/rss.xml', 'https://feeds.bbci.co.uk/sport/rss.xml'] },
  { key: 'arts', label: 'Arts', spoken: 'arts and entertainment news',
    feeds: ['https://feeds.npr.org/1008/rss.xml', 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml'] },
];
export const BY_KEY = Object.fromEntries(CATEGORIES.map((c) => [c.key, c]));
const DEFAULT_CATEGORIES = ['world', 'nation', 'health'];

const feeds = new Map();   // url -> {at, stories}, held while the function is warm
const parser = new XMLParser({ ignoreAttributes: true, processEntities: true, htmlEntities: true });

/* ── the feeds ───────────────────────────────────────────────────────── */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function clean(value) {
  const text = typeof value === 'string' ? value : (value && value['#text']) || (value == null ? '' : String(value));
  return text.replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ').trim();
}

function summarise(value) {
  const text = clean(value);
  if (text.length <= SUMMARY_CHARS) return text;
  const cut = text.slice(0, SUMMARY_CHARS);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (stop > 120 ? cut.slice(0, stop + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`).trim();
}

function parse(body, url, category) {
  const doc = parser.parse(body);
  let items = doc?.rss?.channel?.item || [];
  if (!Array.isArray(items)) items = [items];
  return items.slice(0, MAX_PER_FEED).map((item) => {
    const title = clean(item.title);
    const link = clean(item.link);
    if (!title || !link) return null;
    const stamp = item.pubDate || item['dc:date'];
    const published = stamp ? new Date(stamp) : null;
    return {
      id: crypto.createHash('md5').update(link).digest('hex').slice(0, 10),
      title,
      summary: summarise(item.description),
      url: link,
      source: url.includes('npr.org') ? 'NPR' : url.includes('bbc') ? 'BBC' : 'News',
      category: category.key,
      category_label: category.label,
      published: published && !Number.isNaN(published.getTime()) ? published : null,
    };
  }).filter(Boolean);
}

async function feed(url, category, force) {
  const cached = feeds.get(url);
  if (cached && !force && Date.now() - cached.at < TTL) return cached.stories;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Ask/1.0 (+assistant)' }, signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const stories = parse(await res.text(), url, category);
    feeds.set(url, { at: Date.now(), stories });
    return stories;
  } catch (error) {
    console.warn(`news feed failed (${url}): ${error.message}`);
    return cached ? cached.stories : [];
  }
}

function ago(when) {
  if (!when) return '';
  const s = (Date.now() - when.getTime()) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} minutes ago`;
  if (s < 7200) return 'an hour ago';
  if (s < 86400) return `${Math.floor(s / 3600)} hours ago`;
  if (s < 172800) return 'yesterday';
  return `${Math.floor(s / 86400)} days ago`;
}

const normal = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export async function stories(categories, force = false, limit = 24) {
  let keys = (categories || await selected()).filter((k) => BY_KEY[k]);
  if (!keys.length) keys = [...DEFAULT_CATEGORIES];

  const jobs = keys.flatMap((key) => BY_KEY[key].feeds.map((url) => ({ key, url })));
  const fetched = await Promise.all(jobs.map((job) => feed(job.url, BY_KEY[job.key], force)));
  if (!fetched.some((list) => list.length)) throw new HttpError(502, 'news', 'The news could not be fetched.');

  const groups = keys.map((key) => jobs.flatMap((job, i) => (job.key === key ? fetched[i] : []))
    .sort((a, b) => (b.published?.getTime() || 0) - (a.published?.getTime() || 0)));

  const mixed = [];
  const seen = new Set();
  const rows = Math.max(0, ...groups.map((g) => g.length));
  for (let row = 0; row < rows; row++) {
    for (const group of groups) {
      const story = group[row];
      if (!story) continue;
      const fingerprint = normal(story.title);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      mixed.push({ ...story, ago: ago(story.published), published: story.published ? story.published.toISOString() : null });
    }
  }
  return mixed.slice(0, limit);
}

/* ── what the senior follows, and where the reading is up to ─────────── */

const KEY = 'news';
const blank = () => ({ categories: null, reading: { stories: [], at: 0, atTime: 0, category: null } });

export async function selected() {
  const stored = (await read(KEY, blank)).categories;
  const keys = Array.isArray(stored) ? stored.filter((k) => BY_KEY[k]) : [];
  return keys.length ? keys : [...DEFAULT_CATEGORIES];
}

export async function saveCategories(keys) {
  if (typeof keys === 'string') keys = [keys];
  if (!Array.isArray(keys)) throw new HttpError(400, 'invalid_categories', 'Please choose at least one kind of news.');
  const chosen = CATEGORIES.map((c) => c.key).filter((k) => keys.includes(k));
  if (!chosen.length) throw new HttpError(400, 'invalid_categories', 'Please choose at least one kind of news.');
  await update(KEY, blank, (store) => {
    store.categories = chosen;
    store.reading = blank().reading;
  });
  return chosen;
}

export async function catalogue() {
  const following = new Set(await selected());
  return CATEGORIES.map(({ key, label, spoken }) => ({ key, label, spoken, following: following.has(key) }));
}

export async function beginReading(found, category = null) {
  await update(KEY, blank, (store) => {
    store.reading = { stories: found, at: 0, atTime: Date.now(), category };
  });
}

const reading = async () => (await read(KEY, blank)).reading || blank().reading;

export async function readingActive() {
  const r = await reading();
  return r.stories.length > 0 && Date.now() - r.atTime < READING_TTL;
}

export async function currentStory() {
  const r = await reading();
  return r.stories.length ? r.stories[Math.min(r.at, r.stories.length - 1)] : null;
}

export async function advance() {
  return update(KEY, blank, (store) => {
    const r = store.reading;
    if (!r || !r.stories.length || r.at + 1 >= r.stories.length) return update.SKIP;
    r.at += 1;
    r.atTime = Date.now();
    return r.stories[r.at];
  }) ?? null;
}

export async function lastRead() {
  const r = await reading();
  return [r.stories, r.category];
}

/* ── saying it out loud ──────────────────────────────────────────────── */

const spokenTitle = (s) => s.title.trim().replace(/\.+$/, '').replace(/\s*[-–—]\s*$/, '');
const stop = (t) => (/[.?!]$/.test(t) ? t : `${t}.`);

export function headlinesLine(found, category) {
  if (!found.length) return "I couldn't find any headlines just now. Please try again in a moment.";
  const lead = BY_KEY[category] ? `Here's the ${BY_KEY[category].spoken}.`
    : `Here are the top ${found.length === 1 ? 'story' : 'stories'}.`;
  const parts = [lead, ...found.map((s, i) =>
    stop(`${i === 0 ? '' : i < found.length - 1 ? 'Next, ' : 'And, '}${spokenTitle(s)}`))];
  parts.push('Say tell me more for the first one, or next story to move on.');
  return parts.join(' ');
}

export function storyLine(story, lead = '') {
  if (!story) return "I don't have that story any more. Say what's the news to start again.";
  const parts = [stop(`${lead}${spokenTitle(story)}`)];
  if (story.summary) parts.push(story.summary);
  parts.push(`That's from ${story.source}${story.ago ? `, ${story.ago}` : ''}.`);
  return parts.join(' ');
}

export async function followingLine() {
  const names = (await selected()).map((k) => BY_KEY[k].spoken);
  const listed = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `You're following ${listed}. Say news settings to change what you get.`;
}

export const exhaustedLine = () => "That's the last of the stories I read out. Say what's the news for a fresh set.";
