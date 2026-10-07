"""The medicine schedule Medora keeps - stored in a local JSON file, and
offered to the model as tools it may call whenever the question is about
what to take, when to take it, or what has already been taken.

The dispenser itself is reached over Bluetooth by the browser
(static/medora.js). This module is only the schedule both ends agree on:
the app writes it here, syncs it to the device, and posts back whatever
the device resolved on its own.

A dose is identified the same way at both ends - by its container and its
occurrence minute, which is wall-clock minutes since 1970 in local time.
That is what the device stores, so nothing has to agree about time zones.
"""

import datetime
import json
import logging
import os
import re
import threading
import uuid

log = logging.getLogger(__name__)

STORE_PATH = os.path.join(os.path.dirname(__file__), "medicines.json")
_lock = threading.Lock()

CONTAINERS = (1, 2, 3, 4, 5)
MAX_TIMES = 3
MAX_QUANTITY = 10

GRACE_MINUTES = 5

SEARCH_DAYS = 62

HISTORY_DAYS = 30

DAY_NAMES = ("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday",
             "Friday", "Saturday")

_TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
_EPOCH = datetime.datetime(1970, 1, 1)

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "list_medicines",
            "description": (
                "Look up everything Medora is holding - each medicine, when "
                "it is taken, and which container it is in. Use it for any "
                "question about what they are taking, and before changing or "
                "removing a medicine whose id you do not already have."
            ),
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "next_dose",
            "description": (
                "What the person has to take next, and whether a dose is due "
                "right now. Use it for \"what do I take next\", \"is anything "
                "due\", or \"when is my next pill\"."
            ),
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
]

NAMES = {t["function"]["name"] for t in TOOLS}

class MedicineValidationError(ValueError):
    """The requested medicine data is incomplete or malformed."""

class MedicineNotFoundError(LookupError):
    """No stored medicine has the requested id."""

def local_minute(moment=None):
    moment = moment or datetime.datetime.now()
    return int((moment - _EPOCH).total_seconds() // 60)

def minute_to_datetime(minute):
    return _EPOCH + datetime.timedelta(minutes=int(minute))

def _blank():
    return {"medicines": [], "doses": []}

def _load():
    try:
        with open(STORE_PATH, "r", encoding="utf-8") as f:
            stored = json.load(f)
    except FileNotFoundError:
        return _blank()
    except (json.JSONDecodeError, OSError) as exc:
        log.error("could not read %s: %s", STORE_PATH, exc)
        return _blank()

    if not isinstance(stored, dict):
        return _blank()

    return {
        "medicines": stored.get("medicines") or [],
        "doses": stored.get("doses") or [],
    }

def _save(store):
    tmp = STORE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(store, f, indent=2)
    os.replace(tmp, STORE_PATH)

def _prune(store):
    cutoff = local_minute() - HISTORY_DAYS * 24 * 60
    store["doses"] = [d for d in store["doses"] if d["minute"] >= cutoff]
    return store

def _find(store, medicine_id):
    return next((m for m in store["medicines"] if m["id"] == medicine_id), None)

def _dose_key(container, minute):
    return f"{container}:{minute}"

def _resolved(store):
    return {_dose_key(d["container"], d["minute"]): d for d in store["doses"]}

def _sort_key(medicine):
    return (medicine["container"], medicine["name"].lower())

def list_all():
    """Every medicine, in container order, for the app and the API."""
    with _lock:
        return sorted((dict(m) for m in _load()["medicines"]), key=_sort_key)

def snapshot():
    """Everything the app needs in one request: schedule, answered doses,
    and the doses coming up."""
    with _lock:
        store = _load()
        medicines = sorted((dict(m) for m in store["medicines"]), key=_sort_key)
        doses = [dict(d) for d in store["doses"]]
        upcoming = _upcoming(store, limit=3)

    return {"medicines": medicines, "doses": doses, "upcoming": upcoming}

def _occurrences(store, days_ahead=SEARCH_DAYS):
    """Every scheduled dose from the start of today onwards, in order."""
    now = datetime.datetime.now()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    found = []

    for medicine in store["medicines"]:
        for offset in range(days_ahead):
            day = start + datetime.timedelta(days=offset)
            if ((day.weekday() + 1) % 7) not in medicine["days"]:
                continue

            for value in medicine["times"]:
                hours, minutes = (int(part) for part in value.split(":"))
                at = day.replace(hour=hours, minute=minutes)
                found.append({
                    "medicine_id": medicine["id"],
                    "name": medicine["name"],
                    "quantity": medicine["quantity"],
                    "container": medicine["container"],
                    "minute": local_minute(at),
                    "date": at.strftime("%Y-%m-%d"),
                    "time": at.strftime("%H:%M"),
                    "at": at,
                })

    found.sort(key=lambda dose: (dose["minute"], dose["name"].lower()))
    return found

def _unanswered(store, days_ahead=SEARCH_DAYS):
    """Doses still waiting for an answer: everything ahead, plus anything
    that came due in the last few minutes and was never answered."""
    resolved = _resolved(store)
    earliest = local_minute() - GRACE_MINUTES

    return [
        dose for dose in _occurrences(store, days_ahead)
        if dose["minute"] >= earliest
        and _dose_key(dose["container"], dose["minute"]) not in resolved
    ]

def _public(dose):
    return {key: value for key, value in dose.items() if key != "at"}

def _upcoming(store, limit=3):
    return [_public(dose) for dose in _unanswered(store)[:limit]]

def upcoming(limit=3):
    """The next few doses still waiting for an answer."""
    with _lock:
        return _upcoming(_load(), limit)

def due_now(grace_minutes=GRACE_MINUTES):
    """Doses that came due within the grace period and have not been
    answered - what the assistant speaks a reminder for."""
    now = local_minute()
    with _lock:
        pending = _unanswered(_load())

    return [_public(dose) for dose in pending
            if now - grace_minutes <= dose["minute"] <= now]

def _text(value):
    return value.strip() if isinstance(value, str) else ""

def _clean_times(values):
    if isinstance(values, str):
        values = [values]
    if not isinstance(values, (list, tuple)) or not values:
        raise MedicineValidationError("Please choose a time for every dose.")

    times = []
    for value in values:
        value = _text(value)
        if not _TIME_RE.match(value):
            raise MedicineValidationError(
                "Please give each dose time as a 24-hour time, like 09:00.")
        times.append(value)

    if len(set(times)) != len(times):
        raise MedicineValidationError("Each dose needs a different time.")
    if len(times) > MAX_TIMES:
        raise MedicineValidationError(
            f"Medora can hold up to {MAX_TIMES} doses a day for one medicine.")

    return sorted(times)

def _clean_days(values):
    if values is None:
        return [0, 1, 2, 3, 4, 5, 6]

    if isinstance(values, (int, str)):
        values = [values]
    if not isinstance(values, (list, tuple)):
        raise MedicineValidationError("Please choose at least one day.")

    days = set()
    for value in values:
        try:
            day = int(value)
        except (TypeError, ValueError):
            raise MedicineValidationError(
                "Days run from 0 for Sunday to 6 for Saturday.") from None
        if not 0 <= day <= 6:
            raise MedicineValidationError(
                "Days run from 0 for Sunday to 6 for Saturday.")
        days.add(day)

    if not days:
        raise MedicineValidationError("Please choose at least one day.")
    return sorted(days)

def _clean_quantity(value):
    if value in (None, ""):
        return 1
    try:
        quantity = int(value)
    except (TypeError, ValueError):
        raise MedicineValidationError(
            "Please give the number to take as a whole number.") from None
    if not 1 <= quantity <= MAX_QUANTITY:
        raise MedicineValidationError(
            f"A dose can be from 1 to {MAX_QUANTITY} at a time.")
    return quantity

def _clean_container(value, taken):
    free = [c for c in CONTAINERS if c not in taken]
    if not free:
        raise MedicineValidationError(
            "All five of Medora's containers are in use. "
            "Remove a medicine to free one.")

    if value in (None, ""):
        return free[0]

    try:
        container = int(value)
    except (TypeError, ValueError):
        raise MedicineValidationError("Please choose an available container.") from None
    if container not in CONTAINERS:
        raise MedicineValidationError("Medora's containers are numbered 1 to 5.")
    if container in taken:
        raise MedicineValidationError(f"Container {container} is already in use.")
    return container

def create_medicine(name, times, days=None, quantity=None, container=None):
    """Add a medicine and return a detached copy of it."""
    name = re.sub(r"\s+", " ", _text(name))
    if not name:
        raise MedicineValidationError("Please give the medicine a name.")
    if len(name) > 80:
        raise MedicineValidationError("Please keep the name under 80 characters.")

    times = _clean_times(times)
    days = _clean_days(days)
    quantity = _clean_quantity(quantity)

    with _lock:
        store = _load()
        taken = {m["container"] for m in store["medicines"]}
        medicine = {
            "id": uuid.uuid4().hex[:8],
            "name": name,
            "quantity": quantity,
            "container": _clean_container(container, taken),
            "days": days,
            "times": times,
        }
        store["medicines"].append(medicine)
        _save(_prune(store))

    log.info("added medicine %s: %r in container %d at %s",
             medicine["id"], name, medicine["container"], ", ".join(times))
    return dict(medicine)

def delete_medicine(medicine_id):
    """Remove a medicine and return the one that was removed."""
    medicine_id = _text(medicine_id)
    with _lock:
        store = _load()
        medicine = _find(store, medicine_id)
        if not medicine:
            raise MedicineNotFoundError("That medicine is no longer in Medora.")
        store["medicines"] = [m for m in store["medicines"]
                              if m["id"] != medicine_id]
        _save(_prune(store))

    log.info("removed medicine %s: %r", medicine_id, medicine["name"])
    return dict(medicine)

def record_dose_result(container, minute, status):
    """Write down one answered dose, identified the way the device does.

    Answering the same dose twice is not an error - the device and the app
    can both report the same press, and the later word wins."""
    try:
        container = int(container)
        minute = int(minute)
    except (TypeError, ValueError):
        raise MedicineValidationError("That dose could not be identified.") from None

    status = _text(status).upper()[:1] or "T"
    if container not in CONTAINERS:
        raise MedicineValidationError("Medora's containers are numbered 1 to 5.")
    if status not in ("T", "S"):
        raise MedicineValidationError("A dose is either taken or skipped.")

    dose = {"container": container, "minute": minute, "status": status}
    with _lock:
        store = _load()
        store["doses"] = [d for d in store["doses"]
                          if not (d["container"] == container and d["minute"] == minute)]
        store["doses"].append(dose)
        _save(_prune(store))

    log.info("dose %s for container %d at %s",
             "taken" if status == "T" else "skipped", container,
             minute_to_datetime(minute).strftime("%Y-%m-%d %H:%M"))
    return dict(dose)

def _spoken_time(at):
    minute = at.strftime(":%M") if at.minute else ""
    hour = at.hour % 12 or 12
    return f"{hour}{minute} {'AM' if at.hour < 12 else 'PM'}"

def _spoken_day(at):
    today = datetime.date.today()
    days = (at.date() - today).days
    if days == 0:
        return "today"
    if days == 1:
        return "tomorrow"
    if days < 7:
        return f"on {DAY_NAMES[(at.weekday() + 1) % 7]}"
    return f"on {at.strftime('%B')} {at.day}"

def _spoken_dose(dose):
    quantity = dose["quantity"]
    return (f"{quantity} {dose['name']}" if quantity > 1
            else f"your {dose['name']}")

def _spoken_list(parts):
    if len(parts) == 1:
        return parts[0]
    return ", ".join(parts[:-1]) + f" and {parts[-1]}"

def next_dose_line():
    """One spoken sentence about what is next - the reply to the voice
    command that opens Medora."""
    with _lock:
        store = _load()
        if not store["medicines"]:
            return ("You haven't added any medicines yet. "
                    "You can add one in Medora.")
        pending = _unanswered(store)

    if not pending:
        return "Nothing is due. Medora has no more doses scheduled."

    now = local_minute()
    due = [dose for dose in pending if dose["minute"] <= now]
    if due:
        return (f"It's time for {_spoken_list([_spoken_dose(d) for d in due])}. "
                f"Press taken on Medora when you have.")

    first = pending[0]
    together = [d for d in pending if d["minute"] == first["minute"]]
    what = _spoken_list([_spoken_dose(d) for d in together])
    return (f"Your next dose is {what}, "
            f"{_spoken_day(first['at'])} at {_spoken_time(first['at'])}.")

_COUNT_WORDS = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five"}

def _sentence(text):
    return text[:1].upper() + text[1:]

def upcoming_doses_line(limit=3):
    """The next few doses, read out - the answer to "read my upcoming doses".

    One sentence each, because the synthesiser is given the answer a
    sentence at a time and a long unbroken list is hard to hold on to."""
    with _lock:
        store = _load()
        if not store["medicines"]:
            return ("You haven't added any medicines yet. "
                    "You can add one in Medora.")
        pending = _unanswered(store)

    if not pending:
        return "Nothing is coming up. Medora has no more doses scheduled."

    now = local_minute()
    parts = []
    for index, dose in enumerate(pending[:limit]):
        when = ("due now" if dose["minute"] <= now
                else f"{_spoken_day(dose['at'])} at {_spoken_time(dose['at'])}")
        lead = "then " if index else ""
        parts.append(_sentence(f"{lead}{_spoken_dose(dose)}, {when}."))

    if len(parts) == 1:
        return f"Just one dose is coming up. {parts[0]}"

    count = _COUNT_WORDS.get(len(parts), str(len(parts)))
    return " ".join([f"You have {count} doses coming up.", *parts])

def _describe_schedule(medicine):
    times = ", ".join(_spoken_time(datetime.datetime(2000, 1, 1,
                                                     *(int(p) for p in value.split(":"))))
                      for value in medicine["times"])
    days = ("every day" if len(medicine["days"]) == 7
            else ", ".join(DAY_NAMES[day] for day in medicine["days"]))
    return f"{medicine['quantity']} at {times}, {days}"

def call(name: str, args: dict) -> str:
    """Run one medicine tool call. Returns plain text for the model."""
    handler = {
        "list_medicines": _list,
        "next_dose": _next,
    }.get(name)
    return handler(args) if handler else "Unknown medicine action."

def _list(_args: dict) -> str:
    medicines = list_all()
    if not medicines:
        return "Medora is empty - no medicines have been added yet."

    lines = [f"id {m['id']}: {m['name']}, container {m['container']}, "
             f"{_describe_schedule(m)}" for m in medicines]
    return "\n".join(lines)

def _next(_args: dict) -> str:
    with _lock:
        store = _load()
        if not store["medicines"]:
            return "Medora is empty - no medicines have been added yet."
        pending = _unanswered(store)

    if not pending:
        return "Nothing is scheduled from here on."

    now = local_minute()
    lines = []
    for dose in pending[:4]:
        late = now - dose["minute"]
        when = ("due now" if 0 <= late <= GRACE_MINUTES
                else f"{_spoken_day(dose['at'])} at {_spoken_time(dose['at'])}")
        lines.append(f"{dose['quantity']} x {dose['name']} "
                     f"(container {dose['container']}): {when}")
    return "\n".join(lines)
