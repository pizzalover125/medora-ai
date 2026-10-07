"""The news, answered without the model.

Headlines come from the outlets' own RSS feeds - no API key and no account,
the same way the forecast comes from Open-Meteo. Every category is read from
two outlets, so one of them being down, or simply quiet, does not empty the
app.

What is read aloud is only ever the headlines: three of them, then more of a
story if it is asked for. A senior listening to a list cannot scroll back, so
the list stays short and the app holds the rest.
"""

import datetime
import hashlib
import html
import json
import logging
import os
import re
import threading
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

import requests

log = logging.getLogger(__name__)

STORE_PATH = os.path.join(os.path.dirname(__file__), "news.json")
TIMEOUT = 12
TTL = 10 * 60
MAX_PER_FEED = 8
HEADLINE_COUNT = 3
SUMMARY_CHARS = 320

READING_TTL = 15 * 60

CATEGORIES = [
    {
        "key": "world", "label": "World", "spoken": "world news",
        "feeds": ("https://feeds.npr.org/1004/rss.xml",
                  "https://feeds.bbci.co.uk/news/world/rss.xml"),
    },
    {
        "key": "nation", "label": "National", "spoken": "national news",
        "feeds": ("https://feeds.npr.org/1003/rss.xml",
                  "https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml"),
    },
    {
        "key": "business", "label": "Business", "spoken": "business news",
        "feeds": ("https://feeds.npr.org/1006/rss.xml",
                  "https://feeds.bbci.co.uk/news/business/rss.xml"),
    },
    {
        "key": "health", "label": "Health", "spoken": "health news",
        "feeds": ("https://feeds.npr.org/1128/rss.xml",
                  "https://feeds.bbci.co.uk/news/health/rss.xml"),
    },
    {
        "key": "science", "label": "Science", "spoken": "science news",
        "feeds": ("https://feeds.npr.org/1007/rss.xml",
                  "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml"),
    },
    {
        "key": "sports", "label": "Sports", "spoken": "sports news",
        "feeds": ("https://feeds.npr.org/1055/rss.xml",
                  "https://feeds.bbci.co.uk/sport/rss.xml"),
    },
    {
        "key": "arts", "label": "Arts", "spoken": "arts and entertainment news",
        "feeds": ("https://feeds.npr.org/1008/rss.xml",
                  "https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml"),
    },
]

BY_KEY = {category["key"]: category for category in CATEGORIES}
DEFAULT_CATEGORIES = ("world", "nation", "health")

_lock = threading.Lock()
_feeds = {}
_reading = {"stories": [], "at": 0, "at_time": 0.0, "category": None}

class NewsError(RuntimeError):
    """The headlines could not be fetched."""

_TAGS = re.compile(r"<[^>]+>")
_SPACE = re.compile(r"\s+")

def _clean(text):
    """RSS descriptions arrive with markup and entities in them."""
    return _SPACE.sub(" ", html.unescape(_TAGS.sub(" ", text or ""))).strip()

def _summarise(text):
    text = _clean(text)
    if len(text) <= SUMMARY_CHARS:
        return text

    cut = text[:SUMMARY_CHARS]
    stop = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
    return (cut[:stop + 1] if stop > 120 else cut.rsplit(" ", 1)[0] + "…").strip()

def _published(item):
    stamp = item.findtext("pubDate") or item.findtext("{http://purl.org/dc/elements/1.1/}date")
    if not stamp:
        return None
    try:
        from email.utils import parsedate_to_datetime
        when = parsedate_to_datetime(stamp)
    except (TypeError, ValueError):
        try:
            when = datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        except ValueError:
            return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=datetime.timezone.utc)
    return when

def _source_of(url):
    if "npr.org" in url:
        return "NPR"
    if "bbc" in url:
        return "BBC"
    return "News"

def _parse(body, url, category):
    root = ET.fromstring(body)
    stories = []

    for item in root.findall(".//item")[:MAX_PER_FEED]:
        title = _clean(item.findtext("title"))
        link = (item.findtext("link") or "").strip()
        if not title or not link:
            continue

        stories.append({
            "id": hashlib.md5(link.encode("utf-8")).hexdigest()[:10],
            "title": title,
            "summary": _summarise(item.findtext("description")),
            "url": link,
            "source": _source_of(url),
            "category": category["key"],
            "category_label": category["label"],
            "published": _published(item),
        })

    return stories

def _feed(url, category, force=False):
    """One feed, cached. A stale copy beats an empty app."""
    with _lock:
        cached = _feeds.get(url)
        if cached and not force and (time.time() - cached[0]) < TTL:
            return cached[1]

    try:
        resp = requests.get(url, timeout=TIMEOUT,
                            headers={"User-Agent": "Ask/1.0 (+local assistant)"})
        resp.raise_for_status()
        stories = _parse(resp.content, url, category)
    except Exception as exc:
        log.warning("news feed failed (%s): %s", url, exc)
        with _lock:
            cached = _feeds.get(url)
        return cached[1] if cached else []

    with _lock:
        _feeds[url] = (time.time(), stories)
    return stories

def _normal(title):
    return re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()

def _interleave(groups):
    """Round robin, so three chosen categories are three voices rather than
    whichever outlet published most in the last hour."""
    mixed = []
    for row in range(max((len(group) for group in groups), default=0)):
        for group in groups:
            if row < len(group):
                mixed.append(group[row])
    return mixed

def stories(categories=None, force=False, limit=24):
    """The latest stories across the chosen categories, newest first within
    each, and interleaved between them."""
    keys = [key for key in (categories or selected()) if key in BY_KEY]
    if not keys:
        keys = list(DEFAULT_CATEGORIES)

    jobs = [(BY_KEY[key], url) for key in keys for url in BY_KEY[key]["feeds"]]
    with ThreadPoolExecutor(max_workers=min(8, len(jobs) or 1)) as pool:
        fetched = list(pool.map(lambda job: _feed(job[1], job[0], force), jobs))

    if not any(fetched):
        raise NewsError("no headlines could be fetched")

    groups = []
    for key in keys:
        group = [story for job, found in zip(jobs, fetched) if job[0]["key"] == key
                 for story in found]
        group.sort(key=lambda story: story["published"] or datetime.datetime.min.replace(
            tzinfo=datetime.timezone.utc), reverse=True)
        groups.append(group)

    seen = set()
    mixed = []
    for story in _interleave(groups):
        fingerprint = _normal(story["title"])
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        mixed.append(_shape(story))

    return mixed[:limit]

def _ago(when):
    if not when:
        return ""

    seconds = (datetime.datetime.now(datetime.timezone.utc) - when).total_seconds()
    if seconds < 90:
        return "just now"
    if seconds < 3600:
        return f"{int(seconds // 60)} minutes ago"
    if seconds < 7200:
        return "an hour ago"
    if seconds < 86400:
        return f"{int(seconds // 3600)} hours ago"
    if seconds < 172800:
        return "yesterday"
    return f"{int(seconds // 86400)} days ago"

def _shape(story):
    shaped = dict(story)
    when = shaped.pop("published")
    shaped["ago"] = _ago(when)
    shaped["published"] = when.isoformat() if when else None
    return shaped

def _load():
    try:
        with open(STORE_PATH, "r", encoding="utf-8") as f:
            stored = json.load(f)
    except FileNotFoundError:
        return {}
    except (json.JSONDecodeError, OSError) as exc:
        log.error("could not read %s: %s", STORE_PATH, exc)
        return {}
    return stored if isinstance(stored, dict) else {}

def _save(store):
    tmp = STORE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(store, f, indent=2)
    os.replace(tmp, STORE_PATH)

def selected():
    """The categories being followed, in the order they are shown."""
    stored = _load().get("categories")
    if not isinstance(stored, list):
        return list(DEFAULT_CATEGORIES)

    keys = [key for key in stored if key in BY_KEY]
    return keys or list(DEFAULT_CATEGORIES)

class NewsValidationError(ValueError):
    """The requested categories are not ones we carry."""

def save_categories(keys):
    """Replace the followed categories and return the new list."""
    if isinstance(keys, str):
        keys = [keys]
    if not isinstance(keys, (list, tuple)):
        raise NewsValidationError("Please choose at least one kind of news.")

    chosen = [category["key"] for category in CATEGORIES
              if category["key"] in set(keys)]
    if not chosen:
        raise NewsValidationError("Please choose at least one kind of news.")

    with _lock:
        _save({**_load(), "categories": chosen})
    forget_reading()

    log.info("news categories: %s", ", ".join(chosen))
    return chosen

def catalogue():
    """Every category, with whether it is being followed."""
    following = set(selected())
    return [{"key": category["key"], "label": category["label"],
             "spoken": category["spoken"], "following": category["key"] in following}
            for category in CATEGORIES]

def begin_reading(found, category=None):
    with _lock:
        _reading["stories"] = found
        _reading["at"] = 0
        _reading["at_time"] = time.time()
        _reading["category"] = category

def forget_reading():
    with _lock:
        _reading["stories"] = []
        _reading["at"] = 0
        _reading["at_time"] = 0.0
        _reading["category"] = None

def reading_active():
    """True while "tell me more" still has something to refer to."""
    with _lock:
        return bool(_reading["stories"]) and (time.time() - _reading["at_time"]) < READING_TTL

def current_story():
    with _lock:
        if not _reading["stories"]:
            return None
        return _reading["stories"][min(_reading["at"], len(_reading["stories"]) - 1)]

def advance():
    """Step to the next story, or None when the list runs out."""
    with _lock:
        if not _reading["stories"]:
            return None
        if _reading["at"] + 1 >= len(_reading["stories"]):
            return None
        _reading["at"] += 1
        _reading["at_time"] = time.time()
        return _reading["stories"][_reading["at"]]

def last_read():
    with _lock:
        return list(_reading["stories"]), _reading["category"]

_ORDINALS = ("First", "Second", "Third", "Fourth", "Fifth")

def _spoken_title(story):
    """A headline as it should be heard: no trailing stop, no stray dashes."""
    title = story["title"].strip().rstrip(".")
    return re.sub(r"\s*[-–—]\s*$", "", title)

def _stop(text):
    """End a sentence, unless the headline already asked a question."""
    return text if text.endswith((".", "?", "!")) else text + "."

def headlines_line(found, category=None):
    """The three headlines, read out."""
    if not found:
        return ("I couldn't find any headlines just now. "
                "Please try again in a moment.")

    lead = (f"Here's the {BY_KEY[category]['spoken']}." if category in BY_KEY
            else f"Here are the top {'story' if len(found) == 1 else 'stories'}.")

    parts = [lead]
    for index, story in enumerate(found):
        prefix = "" if index == 0 else ("Next, " if index < len(found) - 1 else "And, ")
        parts.append(_stop(f"{prefix}{_spoken_title(story)}"))

    parts.append("Say tell me more for the first one, or next story to move on.")
    return " ".join(parts)

def story_line(story, lead=""):
    """One story with as much of it as we have."""
    if not story:
        return "I don't have that story any more. Say what's the news to start again."

    when = f", {story['ago']}" if story["ago"] else ""
    parts = [_stop(f"{lead}{_spoken_title(story)}")]
    if story["summary"]:
        parts.append(story["summary"])
    parts.append(f"That's from {story['source']}{when}.")
    return " ".join(parts)

def following_line():
    names = [BY_KEY[key]["spoken"] for key in selected()]
    if len(names) == 1:
        listed = names[0]
    else:
        listed = ", ".join(names[:-1]) + f" and {names[-1]}"
    return (f"You're following {listed}. "
            "Say news settings to change what you get.")

def exhausted_line():
    return ("That's the last of the stories I read out. "
            "Say what's the news for a fresh set.")
