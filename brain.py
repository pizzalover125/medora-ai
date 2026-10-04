"""Question answering via the Hack Club AI API (OpenAI-compatible proxy)."""

import datetime
import json
import logging
import os
import re

import requests

import events
import medicines
import search

log = logging.getLogger(__name__)

API_URL = "https://ai.hackclub.com/proxy/v1/chat/completions"
MODEL = os.getenv("HACKCLUB_MODEL", "google/gemini-3.8-flash")
TIMEOUT = 45

# Whether the model is offered the search tool at all.
SEARCH_ENABLED = os.getenv("EXA_SEARCH", "1") == "1"
# How many times it may search before it has to answer with what it has. Each
# round is a network round trip, and the person is waiting in silence.
MAX_ROUNDS = int(os.getenv("EXA_MAX_ROUNDS", "2"))
MAX_PARALLEL = 3

SYSTEM_PROMPT = """You are a warm, patient voice assistant for an older adult. \
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
pharmacist."""

# Whatever the model does, the text is going straight to a speech synthesiser,
# which reads "http colon slash slash" out loud. Strip it all defensively.
_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")      # [text](url) -> text
_URL = re.compile(r"\(?\b(?:https?://|www\.)\S+\)?")
_MARKDOWN = re.compile(r"[*_`#>\[\]|]|~~")


class BrainError(RuntimeError):
    """The upstream AI call failed."""


def _chat(messages, tools=None):
    """One call to the chat endpoint. Returns the assistant message."""
    api_key = os.getenv("HACKCLUB_API_KEY")
    if not api_key:
        raise BrainError("HACKCLUB_API_KEY is not set")

    body = {
        "model": MODEL,
        "messages": messages,
        "temperature": 0.6,
        "max_tokens": 500,
    }
    if tools:
        body["tools"] = tools

    resp = requests.post(
        API_URL,
        headers={"Authorization": f"Bearer {api_key}",
                 "Content-Type": "application/json"},
        json=body,
        timeout=TIMEOUT,
    )

    if resp.status_code == 429:
        raise BrainError("rate limited")
    if not resp.ok:
        log.error("hack club ai %s: %s", resp.status_code, resp.text[:400])
        raise BrainError(f"upstream returned {resp.status_code}")

    try:
        choice = resp.json()["choices"][0]
    except (KeyError, IndexError, ValueError) as exc:
        raise BrainError("unexpected response shape") from exc

    msg = choice.get("message") or {}
    msg["_finish"] = choice.get("finish_reason")
    return msg


def answer(question: str):
    """Ask the model a question. It decides for itself whether to search.

    Returns (speakable_text, searched)."""
    # Without today's date the model burns a whole search working out when
    # "last weekend" was.
    today = datetime.date.today().strftime("%A, %d %B %Y")
    # Stated first and repeated in the rules: the model otherwise falls back on
    # its training cutoff and searches for the wrong year.
    messages = [
        {"role": "system",
         "content": f"Today's date is {today}.\n\n{SYSTEM_PROMPT}"},
        {"role": "user", "content": question},
    ]
    tools = (([search.TOOL] if SEARCH_ENABLED else [])
             + events.TOOLS + medicines.TOOLS)
    searched = False

    for _round in range(MAX_ROUNDS):
        msg = _chat(messages, tools=tools)
        calls = msg.get("tool_calls") or []
        if not calls:
            text = _speakable(msg.get("content"))
            if text:
                return text, searched
            break        # nothing to say and nothing to call: fall through

        # (call, rendered result) pairs, kept in whatever order they resolve -
        # only the tool_call_id has to line up on the way back.
        kept = []
        search_calls, search_queries = [], []
        for call in calls[:MAX_PARALLEL]:
            fn = call.get("function") or {}
            name = fn.get("name")
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except ValueError:
                args = {}

            if name == "web_search":
                query = (args.get("query") or "").strip()
                if query:
                    search_calls.append(call)
                    search_queries.append(query)
            elif name in events.NAMES:
                kept.append((call, events.call(name, args)))
            elif name in medicines.NAMES:
                kept.append((call, medicines.call(name, args)))

        if search_queries:
            searched = True
            kept.extend(zip(search_calls, search.run(search_queries)))

        if not kept:
            # It asked to call a tool but gave nothing usable; make it answer.
            break

        # Echo the assistant turn back with only the calls we actually ran -
        # every tool_call id must be answered or the next request is rejected.
        messages.append({"role": "assistant",
                         "content": msg.get("content") or "",
                         "tool_calls": [call for call, _ in kept]})
        for call, result in kept:
            messages.append({"role": "tool",
                             "tool_call_id": call.get("id"),
                             "content": result})

    # Out of rounds: one last call with no tools, so it has to answer.
    msg = _chat(messages, tools=None)
    text = _speakable(msg.get("content"))

    # A model that spent every round searching sometimes comes back with
    # nothing at all. Silence is the worst possible answer here - the orb would
    # mime speaking and say nothing - so ask once more, plainly.
    if not text:
        log.warning("empty answer after %d round(s) (finish=%s); asking again",
                    MAX_ROUNDS, msg.get("_finish"))
        messages.append({
            "role": "user",
            "content": "Answer my question now, in one or two short spoken "
                       "sentences, using whatever you already found. If you "
                       "could not find it, just say so.",
        })
        text = _speakable(_chat(messages, tools=None).get("content"))

    if not text:
        log.error("still no answer; falling back")
        return "I'm sorry, I couldn't find that out just now.", searched

    return text, searched


def _speakable(text: str) -> str:
    """Strip anything that would be read aloud as punctuation noise."""
    text = _LINK.sub(r"\1", text or "")
    text = _URL.sub("", text)
    text = _MARKDOWN.sub("", text)
    return re.sub(r"\s+", " ", text).strip(" -")
