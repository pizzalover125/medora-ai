"""Video calls between the person using the assistant and one contact.

Only the signalling lives here: the offer, the answer, and the network
candidates the two browsers need to find each other. The picture and the
sound go straight between them and never pass through this process, which is
why this is a dict in memory rather than another JSON file - a call is over
in minutes and means nothing afterwards. What survives it is one line in the
conversation, written when it ends.
"""

import datetime
import logging
import os
import threading
import uuid

import messages

log = logging.getLogger(__name__)

RING_SECONDS = 45
LINGER_SECONDS = 15
MAX_SIGNALS = 400
MAX_SIGNAL_BYTES = 64 * 1024

SIGNAL_KINDS = ("offer", "answer", "candidate")

_lock = threading.Lock()
_call = None

STUN = os.getenv("STUN_URL", "stun:stun.l.google.com:19302")
TURN = os.getenv("TURN_URL", "").strip()
TURN_USER = os.getenv("TURN_USERNAME", "").strip()
TURN_PASSWORD = os.getenv("TURN_PASSWORD", "").strip()

def ice_servers():
    """The list the browsers are given when they open a connection."""
    servers = []
    if STUN:
        servers.append({"urls": STUN})
    if TURN:
        server = {"urls": TURN}
        if TURN_USER:
            server["username"] = TURN_USER
            server["credential"] = TURN_PASSWORD
        servers.append(server)
    return servers

class CallError(RuntimeError):
    """The call cannot be placed or changed as asked."""

class CallBusy(CallError):
    """Someone is already on a call."""

class CallNotFound(CallError):
    """There is no call to answer, end, or signal on."""

def _now():
    return datetime.datetime.now(datetime.timezone.utc)

def _iso(when):
    return when.replace(microsecond=0).isoformat()

def _other(side):
    return messages.CONTACT if side == messages.SENIOR else messages.SENIOR

def _public(call):
    """The parts of a call the browsers are allowed to see."""
    if call is None:
        return None
    return {
        "id": call["id"],
        "slug": call["slug"],
        "contact": dict(call["contact"]),
        "caller": call["caller"],
        "state": call["state"],
        "reason": call["reason"],
        "started": _iso(call["started"]),
        "answered": _iso(call["answered"]) if call["answered"] else None,
    }

def _spoken_length(seconds):
    if seconds < 60:
        return f"{seconds} sec"
    minutes = round(seconds / 60)
    return f"{minutes} min" if minutes != 1 else "1 min"

def _write_history(call, reason):
    """Leave the call in the conversation, the way a phone leaves a log."""
    if reason == "declined":
        text, read = "Video call declined", True
    elif call["answered"]:
        length = _spoken_length(int((_now() - call["answered"]).total_seconds()))
        text, read = f"Video call · {length}", True
    else:
        text, read = "Missed video call", False

    try:
        messages.log_event(call["slug"], call["caller"], text, read=read)
    except messages.MessageValidationError as exc:
        log.error("could not write call history: %s", exc)

def _finish(call, reason):
    if call["state"] == "ended":
        return
    call["state"] = "ended"
    call["reason"] = reason
    call["ended"] = _now()
    _write_history(call, reason)
    log.info("call %s with %s ended (%s)", call["id"], call["slug"], reason)

def _expire():
    """Time out a call nobody answered, and forget one that has ended."""
    global _call
    if _call is None:
        return

    age = (_now() - _call["started"]).total_seconds()
    if _call["state"] == "ringing" and age > RING_SECONDS:
        _finish(_call, "no_answer")

    if _call["state"] == "ended":
        if (_now() - _call["ended"]).total_seconds() > LINGER_SECONDS:
            _call = None

def _active(slug=None):
    """The call in progress, optionally only if it is on this thread."""
    if _call is None or _call["state"] == "ended":
        return None
    if slug is not None and _call["slug"] != slug:
        return None
    return _call

def place(slug, caller):
    """Start ringing the other end of one conversation."""
    global _call
    contact = messages.find_contact(slug)
    if contact is None:
        raise messages.ContactNotFoundError("There is no contact by that name.")
    if caller not in messages.SENDERS:
        raise CallError("A call needs a caller.")

    with _lock:
        _expire()
        if _active() is not None:
            raise CallBusy("That line is busy at the moment.")

        _call = {
            "id": uuid.uuid4().hex[:8],
            "slug": contact["slug"],
            "contact": contact,
            "caller": caller,
            "state": "ringing",
            "reason": None,
            "started": _now(),
            "answered": None,
            "ended": None,
            "seq": 0,
            "mail": {messages.SENIOR: [], messages.CONTACT: []},
        }
        log.info("call %s: %s is calling %s", _call["id"], caller, slug)
        return _public(_call)

def answer(slug, who):
    """Pick up a ringing call."""
    with _lock:
        _expire()
        call = _active(slug)
        if call is None or call["state"] != "ringing":
            raise CallNotFound("That call is no longer ringing.")
        if who == call["caller"]:
            raise CallError("You cannot answer your own call.")

        call["state"] = "connected"
        call["answered"] = _now()
        log.info("call %s answered", call["id"])
        return _public(call)

def end(slug, who, reason=None):
    """Hang up, decline, or cancel - whichever this turns out to be."""
    with _lock:
        _expire()
        call = _active(slug)
        if call is None:
            return None
        if reason not in ("declined", "failed"):
            reason = "hung_up" if call["state"] == "connected" else "cancelled"
        if reason == "cancelled" and who != call["caller"]:
            reason = "declined"
        _finish(call, reason)
        return _public(call)

def signal(slug, sender, kind, data):
    """Leave one piece of WebRTC negotiation for the other end to collect."""
    if kind not in SIGNAL_KINDS:
        raise CallError("That is not something to signal.")
    if not isinstance(data, (dict, list, str)):
        raise CallError("That signal has nothing in it.")
    if len(str(data)) > MAX_SIGNAL_BYTES:
        raise CallError("That signal is too large.")

    with _lock:
        _expire()
        call = _active(slug)
        if call is None:
            raise CallNotFound("That call is over.")
        if sender not in messages.SENDERS:
            raise CallError("A signal needs a sender.")

        call["seq"] += 1
        box = call["mail"][_other(sender)]
        box.append({"seq": call["seq"], "kind": kind, "data": data})
        del box[:-MAX_SIGNALS]
        return _public(call)

def poll(viewer, slug=None, since=0):
    """The call this side can see, and anything signalled to it since `since`."""
    with _lock:
        _expire()
        call = _call
        if call is None or (slug is not None and call["slug"] != slug):
            return None, [], 0

        waiting = [item for item in call["mail"][viewer] if item["seq"] > since]
        cursor = waiting[-1]["seq"] if waiting else since
        return _public(call), waiting, cursor

def reset():
    """Drop any call in progress. Used by the tests."""
    global _call
    with _lock:
        _call = None
