"""Messages between the person using the assistant and the people who check in
on him.

One JSON file holds every thread. The dock app is his end of each
conversation; /grandson, /son and the other contact pages are the other end,
so showing this to someone needs nothing but a second browser tab - or a
phone on the same wifi.
"""

import datetime
import json
import logging
import os
import threading
import uuid

log = logging.getLogger(__name__)

STORE_PATH = os.path.join(os.path.dirname(__file__), "messages.json")
_lock = threading.Lock()

SENIOR = "senior"
CONTACT = "contact"
SENDERS = (SENIOR, CONTACT)
MAX_TEXT = 600

# Each contact is a page at /<slug>. `calls` is what that person calls him, so
# their page is headed the way their own phone would head it. Change a name
# here and both ends follow - the row in his window and the page at /<slug>.
CONTACTS = [
    {"slug": "son", "name": "Michael", "relation": "Son", "calls": "Dad"},
    {"slug": "daughter", "name": "Sarah", "relation": "Daughter", "calls": "Dad"},
    {"slug": "grandson", "name": "Danny", "relation": "Grandson", "calls": "Grandpa"},
    {"slug": "granddaughter", "name": "Emily", "relation": "Granddaughter",
     "calls": "Grandpa"},
    {"slug": "nephew", "name": "Robert", "relation": "Nephew", "calls": "Uncle George"},
    {"slug": "doctor", "name": "Dr. Patel", "relation": "Doctor", "calls": "George"},
]

BY_SLUG = {contact["slug"]: contact for contact in CONTACTS}

# An empty messaging app demonstrates nothing, so the first run writes a few
# days of conversation. (sender, minutes ago, text, already read).
SEED = {
    "son": (
        (CONTACT, 430, "Morning Dad! Did you sleep any better last night?", True),
        (SENIOR, 421, "Much better, thank you. The new pillow helps.", True),
        (CONTACT, 24, "Good. I'll bring the groceries over after work.", False),
    ),
    "daughter": (
        (CONTACT, 1490, "Hi Dad - the pharmacy called, your refill is ready.", True),
        (SENIOR, 1483, "Thank you, love. I'll ask Michael to collect it.", True),
    ),
    "grandson": (
        (CONTACT, 96, "Hi Grandpa! Are we still on for Sunday?", True),
        (SENIOR, 91, "Of course we are. I'll make the lemon cake.", True),
        (CONTACT, 7, "Perfect. Can I bring a friend from school?", False),
    ),
    "granddaughter": (
        (CONTACT, 2890, "Grandpa, look what I painted in art class today!", True),
        (SENIOR, 2874, "It's beautiful. It's going straight on the fridge.", True),
    ),
    "nephew": (
        (CONTACT, 1610, "Hi Uncle George, how did the eye appointment go?", True),
        (SENIOR, 1602, "All clear. New glasses in two weeks.", True),
    ),
    "doctor": (
        (CONTACT, 640,
         "Reminder: your check-up is Thursday at 10:00. "
         "Please bring your list of medications.", True),
        (SENIOR, 628, "Thank you, I have it on my calendar.", True),
    ),
}


class MessageValidationError(ValueError):
    """The requested message is empty, too long, or from nobody."""


class ContactNotFoundError(LookupError):
    """No contact has the requested slug."""


def _now():
    return datetime.datetime.now(datetime.timezone.utc)


def _iso(when):
    return when.replace(microsecond=0).isoformat()


def _message(sender, text, at, read, kind="text"):
    return {"id": uuid.uuid4().hex[:8], "from": sender, "text": text,
            "at": at, "read": read, "kind": kind}


def _seeded():
    now = _now()
    return {
        slug: [
            _message(sender, text, _iso(now - datetime.timedelta(minutes=ago)), read)
            for sender, ago, text, read in lines
        ]
        for slug, lines in SEED.items()
    }


def _load():
    """Return {slug: [message, ...]} for every known contact."""
    try:
        with open(STORE_PATH, "r", encoding="utf-8") as f:
            stored = json.load(f)
        if not isinstance(stored, dict):
            raise ValueError("expected an object of threads")
    except FileNotFoundError:
        stored = _seeded()
        _save(stored)
    except (json.JSONDecodeError, OSError, ValueError) as exc:
        # Don't overwrite a file we couldn't read - start empty for this run
        # and leave whatever is there for a person to look at.
        log.error("could not read %s: %s", STORE_PATH, exc)
        stored = {}

    return {slug: list(stored.get(slug) or []) for slug in BY_SLUG}


def _save(threads):
    # Write to a temp file and rename over the original so a crash mid-write
    # never leaves messages.json half-written.
    tmp = STORE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(threads, f, indent=2)
    os.replace(tmp, STORE_PATH)


def find_contact(slug):
    """Return the contact with this slug, or None."""
    return BY_SLUG.get((slug or "").strip().lower())


def _require(slug):
    contact = find_contact(slug)
    if contact is None:
        raise ContactNotFoundError("There is no contact by that name.")
    return contact


def _unread_for(messages, viewer):
    """Messages the viewer has not seen - the ones the other end sent."""
    other = CONTACT if viewer == SENIOR else SENIOR
    return [m for m in messages if m.get("from") == other and not m.get("read")]


def overview(viewer=SENIOR):
    """Every contact with its last message and unread count, newest first."""
    with _lock:
        threads = _load()

    cards = []
    for contact in CONTACTS:
        messages = threads[contact["slug"]]
        cards.append({
            **contact,
            "last": dict(messages[-1]) if messages else None,
            "unread": len(_unread_for(messages, viewer)),
        })

    # A contact who just wrote belongs at the top; one who never has, at the
    # bottom rather than in the middle of an otherwise chronological list.
    cards.sort(key=lambda card: card["last"]["at"] if card["last"] else "", reverse=True)
    return cards


def thread(slug, viewer=None):
    """Return one conversation. A viewer marks their side's unread as read."""
    _require(slug)
    with _lock:
        threads = _load()
        messages = threads[slug]
        if viewer in SENDERS:
            unread = _unread_for(messages, viewer)
            if unread:
                for message in unread:
                    message["read"] = True
                _save(threads)
                log.info("%s read %d message(s) from %s", viewer, len(unread), slug)
    return [dict(message) for message in messages]


def log_event(slug, sender, text, read=True):
    """Write a line nobody typed - so far, the record a video call leaves.

    It is stored as an ordinary message with `kind` set to "call", so it
    travels with the conversation and both ends can show it as a note rather
    than as something that was said.
    """
    contact = _require(slug)
    if sender not in SENDERS:
        raise MessageValidationError("An event needs a sender.")

    event = _message(sender, text.strip(), _iso(_now()), read=read, kind="call")
    with _lock:
        threads = _load()
        threads[slug].append(event)
        _save(threads)

    log.info("%s thread: %s", contact["slug"], event["text"])
    return dict(event)


def send(slug, sender, text):
    """Append a message to a conversation and return a copy of it."""
    contact = _require(slug)
    sender = (sender or "").strip().lower()
    if sender not in SENDERS:
        raise MessageValidationError("A message needs a sender.")

    text = text.strip() if isinstance(text, str) else ""
    if not text:
        raise MessageValidationError("Please write a message first.")
    if len(text) > MAX_TEXT:
        raise MessageValidationError(
            f"Please keep messages under {MAX_TEXT} characters.")

    message = _message(sender, text, _iso(_now()), read=False)
    with _lock:
        threads = _load()
        threads[slug].append(message)
        _save(threads)

    log.info("message from %s in %s thread: %r",
             "him" if sender == SENIOR else contact["name"], slug, text)
    return dict(message)
