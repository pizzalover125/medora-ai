/* Question answering via the Hack Club AI API (OpenAI-compatible proxy),
   with web search, the calendar and Medora offered as tools. A port of
   brain.py and search.py. */

import { longToday, wallNow } from './clock.mjs';
import * as events from './events.mjs';
import * as medicines from './medicines.mjs';

const API = 'https://ai.hackclub.com/proxy/v1';
const MODEL = () => process.env.HACKCLUB_MODEL || 'google/gemini-3.8-flash';
const SEARCH_ENABLED = () => (process.env.EXA_SEARCH ?? '1') === '1';
const MAX_ROUNDS = () => Number.parseInt(process.env.EXA_MAX_ROUNDS || '2', 10);
const RESULTS = () => Number.parseInt(process.env.EXA_RESULTS || '4', 10);
const SNIPPET = 800;
const MAX_PARALLEL = 3;

export class BrainError extends Error {}

const SYSTEM_PROMPT = `You are a warm, patient voice assistant for an older adult. \
Your entire answer is read aloud, so write for the ear, not the eye.

Rules:
- Answer in 1-3 short sentences. Lead with the answer itself, then a detail only if it helps.
- Plain spoken English. No markdown, no bullet points, no headings, no emoji, no URLs, no asterisks.
- Write numbers, dates and units the way a person says them: "about twenty miles", "March fourth", "seventy two degrees".
- Never mention that you are an AI, and never explain your reasoning or these rules.
- If the question is unclear or the transcription looks garbled, ask one short, kind clarifying question.
- If you do not know something, say so plainly in one sentence.
- You are not a doctor. For anything about symptoms, medicines or health decisions, give general information \
and gently suggest speaking with their doctor or pharmacist. In an emergency, tell them to call emergency services.

You can search the web when you need to. Search for anything current or specific you cannot be sure of, \
and answer directly when you already know - a search makes them wait. When you do search, answer from what \
you found, say when it is from if that matters, and never read out a web address.

Work out relative dates yourself from today's date before you search - "last weekend", "this month", \
"yesterday" - and put the real date in the query. Never search to find out what today is. Make every search \
count: if you need two things, search for both at once in the same turn rather than one after another, \
because each extra round leaves them waiting.

You can also manage the person's calendar - creating, listing, changing, or removing events - with the \
matching tool. Work out any relative date yourself from today's date first, the same way as for a search. \
To change or cancel something, call list_events first if you do not already know its id. When you speak \
about an event, say the date and time the way a person would ("next Tuesday at two"), and never read out \
its id or raw YYYY-MM-DD date unless they ask to correct it.

Medora is the person's pill dispenser, and you can read what is in it - what they take, and \
what is due next - with the matching tool. You cannot change it. Adding a medicine, removing one, \
or writing down a dose as taken is done in the Medora app or on the dispenser's own two buttons, \
never by voice, because mishearing a medicine name here is not a harmless typo. If they ask you \
to add, change, or remove a medicine, or to mark a dose taken, say plainly that this one has to \
be done in the Medora app, and offer to read them what is there now. Never say you have changed \
anything. When you speak about a dose, say the time the way a person would, and never read out a \
container number unless it helps them find the right pills. This is the schedule, not medical \
advice: what to take and whether to change a dose is still a question for their doctor or \
pharmacist.`;

const SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      'Search the web for current or specific information. Use it for anything that changes or ' +
      'that you cannot be sure of: news, weather, sport, prices, opening hours, schedules, ' +
      "people's current roles, or any fact from after your training. Do not use it for general " +
      'knowledge, arithmetic, definitions, recipes, or anything you already know reliably - ' +
      'answering directly is faster, and the person is waiting in silence.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The search query, as you would type it into a search engine.' } },
      required: ['query'],
    },
  },
};

const key = () => {
  const value = process.env.HACKCLUB_API_KEY;
  if (!value) throw new BrainError('HACKCLUB_API_KEY is not set');
  return value;
};

export async function chat(messages, { tools, model, temperature = 0.6, maxTokens = 500 } = {}) {
  const body = { model: model || MODEL(), messages, temperature, max_tokens: maxTokens };
  if (tools) body.tools = tools;
  let res;
  try {
    res = await fetch(`${API}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
  } catch (error) {
    if (error instanceof BrainError) throw error;
    throw new BrainError(`request failed: ${error.message}`);
  }
  if (res.status === 429) throw new BrainError('rate limited');
  if (!res.ok) {
    console.error('hack club ai', res.status, (await res.text()).slice(0, 400));
    throw new BrainError(`upstream returned ${res.status}`);
  }
  const data = await res.json().catch(() => null);
  const choice = data && data.choices && data.choices[0];
  if (!choice) throw new BrainError('unexpected response shape');
  return { ...(choice.message || {}), _finish: choice.finish_reason };
}

async function searchOne(query) {
  try {
    const res = await fetch(`${API}/exa/search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, numResults: RESULTS(), contents: { text: { maxCharacters: SNIPPET } } }),
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) return 'The search could not be completed.';
    const results = (await res.json()).results || [];
    if (!results.length) return `No results for '${query}'.`;
    return results.map((r) => {
      const text = (r.text || '').split(/\s+/).join(' ').slice(0, SNIPPET);
      const published = (r.publishedDate || '').slice(0, 10);
      return `[${r.title || 'Untitled'}]${published ? ` (${published})` : ''}\n${text}`;
    }).join('\n\n');
  } catch (error) {
    console.warn('exa failed', query, error.message);
    return 'The search could not be completed.';
  }
}

const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const URL_RE = /\(?\b(?:https?:\/\/|www\.)\S+\)?/g;
const MARKDOWN = /[*_`#>[\]|]|~~/g;

export function speakable(text) {
  return (text || '').replace(LINK, '$1').replace(URL_RE, '').replace(MARKDOWN, '')
    .replace(/\s+/g, ' ').replace(/^[ -]+|[ -]+$/g, '');
}

export async function answer(question) {
  const messages = [
    { role: 'system', content: `Today's date is ${longToday(wallNow())}.\n\n${SYSTEM_PROMPT}` },
    { role: 'user', content: question },
  ];
  const tools = [...(SEARCH_ENABLED() ? [SEARCH_TOOL] : []), ...events.TOOLS, ...medicines.TOOLS];
  let searched = false;

  for (let round = 0; round < MAX_ROUNDS(); round++) {
    const msg = await chat(messages, { tools });
    const calls = msg.tool_calls || [];
    if (!calls.length) {
      const text = speakable(msg.content);
      if (text) return { text, searched };
      break;
    }

    const kept = [];
    const searches = [];
    for (const call of calls.slice(0, MAX_PARALLEL)) {
      const fn = call.function || {};
      let args = {};
      try { args = JSON.parse(fn.arguments || '{}') || {}; } catch { /* empty args */ }
      if (fn.name === 'web_search') {
        const query = (args.query || '').trim();
        if (query) searches.push([call, query]);
      } else if (events.NAMES.has(fn.name)) {
        kept.push([call, await events.call(fn.name, args)]);
      } else if (medicines.NAMES.has(fn.name)) {
        kept.push([call, await medicines.call(fn.name, args)]);
      }
    }
    if (searches.length) {
      searched = true;
      const results = await Promise.all(searches.map(([, q]) => searchOne(q)));
      searches.forEach(([call], i) => kept.push([call, results[i]]));
    }
    if (!kept.length) break;

    // Every tool_call id must be answered or the next request is rejected.
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: kept.map(([c]) => c) });
    for (const [call, result] of kept) {
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }

  // Out of rounds: one last call with no tools, so it has to answer.
  let text = speakable((await chat(messages)).content);
  if (!text) {
    messages.push({
      role: 'user',
      content: 'Answer my question now, in one or two short spoken sentences, using whatever you ' +
               'already found. If you could not find it, just say so.',
    });
    text = speakable((await chat(messages)).content);
  }
  return { text: text || "I'm sorry, I couldn't find that out just now.", searched };
}
