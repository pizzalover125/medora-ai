import datetime
import json
import logging
import os
import re
import threading
import uuid

log = logging.getLogger(__name__)

STORE_PATH = os.path.join(os.path.dirname(__file__), "events.json")
_lock = threading.Lock()

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "create_event",
            "description": (
                "Add something to the person's calendar - an appointment, "
                "reminder, birthday, or anything else tied to a date. Use it "
                "whenever they ask you to remember, add, book, or set "
                "something for a date or time."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short description, e.g. \"Doctor's appointment\" or \"Call Mary\".",
                    },
                    "date": {
                        "type": "string",
                        "description": (
                            "The event's date as YYYY-MM-DD. Work out relative "
                            "dates (\"next Tuesday\", \"tomorrow\") yourself "
                            "from today's date first - never ask the person "
                            "to repeat it in a different format."
                        ),
                    },
                    "time": {
                        "type": "string",
                        "description": "The event's time as 24-hour HH:MM, if one was given. Omit for an all-day event.",
                    },
                },
                "required": ["title", "date"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_events",
            "description": (
                "Look up what is on the person's calendar. Use it for "
                "anything asking what they have coming up, what is on a "
                "given day, or whether something is already scheduled - and "
                "before changing or cancelling an event whose id you do not "
                "already have from earlier in this conversation."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "from_date": {
                        "type": "string",
                        "description": "Start of the range, YYYY-MM-DD. Defaults to today.",
                    },
                    "to_date": {
                        "type": "string",
                        "description": "End of the range, YYYY-MM-DD, inclusive. Omit for an open-ended upcoming search.",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_event",
            "description": (
                "Change an existing event's title, date, or time. Call "
                "list_events first if you do not already know its id."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "event_id": {"type": "string"},
                    "title": {"type": "string"},
                    "date": {"type": "string", "description": "YYYY-MM-DD"},
                    "time": {
                        "type": "string",
                        "description": "24-hour HH:MM, or an empty string to clear a time that was set.",
                    },
                },
                "required": ["event_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delete_event",
            "description": (
                "Remove an event from the calendar because the person "
                "cancelled it or asked you to forget it. Call list_events "
                "first if you do not already know its id."
            ),
            "parameters": {
                "type": "object",
                "properties": {"event_id": {"type": "string"}},
                "required": ["event_id"],
            },
        },
    },
]

NAMES = {t["function"]["name"] for t in TOOLS}

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")

def _valid_date(s: str) -> bool:
    if not s or not _DATE_RE.match(s):
        return False
    try:
        datetime.date.fromisoformat(s)
        return True
    except ValueError:
        return False

def _sort_key(event):
    return (event["date"], event.get("time") or "99:99")

def _load():
    try:
        with open(STORE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return []
    except (json.JSONDecodeError, OSError) as exc:
        log.error("could not read %s: %s", STORE_PATH, exc)
        return []

def _save(events):
    tmp = STORE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(events, f, indent=2)
    os.replace(tmp, STORE_PATH)

def _find(events, event_id):
    return next((e for e in events if e["id"] == event_id), None)

def list_all():
    """Return a sorted snapshot for the calendar window."""
    with _lock:
        items = _load()
    return sorted(items, key=_sort_key)

class EventValidationError(ValueError):
    """The requested event data is incomplete or malformed."""

class EventNotFoundError(LookupError):
    """No stored event has the requested id."""

def _text(value):
    return value.strip() if isinstance(value, str) else ""

def create_event(title, date, time=None):
    """Create an event and return a detached copy of it."""
    title = _text(title)
    date = _text(date)
    time = _text(time) or None

    if not title:
        raise EventValidationError("Please give the event a title.")
    if len(title) > 160:
        raise EventValidationError("Please keep the event title under 160 characters.")
    if not _valid_date(date):
        raise EventValidationError("Please choose a valid date.")
    if time and not _TIME_RE.match(time):
        raise EventValidationError("Please choose a valid time.")

    event = {"id": uuid.uuid4().hex[:8], "title": title, "date": date, "time": time}
    with _lock:
        items = _load()
        items.append(event)
        _save(items)

    log.info("created event %s: %r on %s", event["id"], title, _when(event))
    return dict(event)

def update_event(event_id, changes):
    """Apply the supplied title/date/time fields and return the updated event."""
    event_id = _text(event_id)
    changes = {key: value for key, value in changes.items()
               if key in {"title", "date", "time"}}
    if not changes:
        raise EventValidationError("There are no changes to save.")

    cleaned = {}
    if "title" in changes:
        cleaned["title"] = _text(changes["title"])
        if not cleaned["title"]:
            raise EventValidationError("Please give the event a title.")
        if len(cleaned["title"]) > 160:
            raise EventValidationError("Please keep the event title under 160 characters.")
    if "date" in changes:
        cleaned["date"] = _text(changes["date"])
        if not _valid_date(cleaned["date"]):
            raise EventValidationError("Please choose a valid date.")
    if "time" in changes:
        cleaned["time"] = _text(changes["time"]) or None
        if cleaned["time"] and not _TIME_RE.match(cleaned["time"]):
            raise EventValidationError("Please choose a valid time.")

    with _lock:
        items = _load()
        event = _find(items, event_id)
        if not event:
            raise EventNotFoundError("That event no longer exists.")
        event.update(cleaned)
        _save(items)
        result = dict(event)

    log.info("updated event %s: %r on %s", event_id, result["title"], _when(result))
    return result

def delete_event(event_id):
    """Delete an event and return the removed event."""
    event_id = _text(event_id)
    with _lock:
        items = _load()
        event = _find(items, event_id)
        if not event:
            raise EventNotFoundError("That event no longer exists.")
        _save([item for item in items if item["id"] != event_id])

    log.info("deleted event %s: %r", event_id, event["title"])
    return dict(event)

def _when(event) -> str:
    return event["date"] if not event.get("time") else f"{event['date']} at {event['time']}"

def call(name: str, args: dict) -> str:
    """Run one calendar tool call. Returns plain text for the model to read."""
    handler = {
        "create_event": _create,
        "list_events": _list,
        "update_event": _update,
        "delete_event": _delete,
    }.get(name)
    return handler(args) if handler else "Unknown calendar action."

def _create(args: dict) -> str:
    try:
        event = create_event(args.get("title"), args.get("date"), args.get("time"))
    except EventValidationError as exc:
        return str(exc)
    return f"Created (id {event['id']}): {event['title']!r} on {_when(event)}."

def _list(args: dict) -> str:
    from_date = (args.get("from_date") or "").strip()
    to_date = (args.get("to_date") or "").strip()
    if from_date and not _valid_date(from_date):
        return "from_date must be YYYY-MM-DD."
    if to_date and not _valid_date(to_date):
        return "to_date must be YYYY-MM-DD."

    with _lock:
        events = _load()

    if from_date:
        events = [e for e in events if e["date"] >= from_date]
    if to_date:
        events = [e for e in events if e["date"] <= to_date]
    events.sort(key=_sort_key)

    if not events:
        return "No events found in that range."
    return "\n".join(
        f"id {e['id']}: {e['title']} on {_when(e)}" for e in events
    )

def _update(args: dict) -> str:
    event_id = (args.get("event_id") or "").strip()
    if not event_id:
        return "No event id was given."

    changes = {}
    if _text(args.get("title")):
        changes["title"] = args["title"]
    if _text(args.get("date")):
        changes["date"] = args["date"]
    if "time" in args:
        changes["time"] = args["time"]
    if not changes:
        return "No changes were given for the event."
    try:
        event = update_event(event_id, changes)
    except EventValidationError as exc:
        return str(exc)
    except EventNotFoundError:
        return f"No event with id {event_id!r}. Call list_events to find the right id."

    return f"Updated: {event['title']!r} now on {_when(event)}."

def _delete(args: dict) -> str:
    event_id = (args.get("event_id") or "").strip()
    if not event_id:
        return "No event id was given."

    try:
        event = delete_event(event_id)
    except EventNotFoundError:
        return f"No event with id {event_id!r}. Call list_events to find the right id."

    return f"Deleted: {event['title']!r}."
