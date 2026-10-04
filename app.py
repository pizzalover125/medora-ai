"""Alexa for Seniors - one button, one answer."""

import importlib.util
import logging
import os
import socket
import subprocess
import sys
import threading

# `python3` may not be the interpreter the dependencies live in - a bare
# ImportError here is confusing, so say what to do instead.
_missing = [m for m in ("flask", "faster_whisper", "requests", "dotenv")
            if importlib.util.find_spec(m) is None]
if _missing:
    sys.exit(
        f"Missing {', '.join(_missing)} for {sys.executable}.\n"
        f"Run ./run.sh instead, or: {sys.executable} -m pip install -r requirements.txt"
    )

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request

load_dotenv()

import brain  # noqa: E402  (must follow load_dotenv so env is populated)
import calls  # noqa: E402
import events  # noqa: E402
import intents  # noqa: E402
import medicines  # noqa: E402
import messages  # noqa: E402
import news  # noqa: E402
import stt  # noqa: E402
import weather  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("medora")

MAX_AUDIO_BYTES = 25 * 1024 * 1024
HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "5001"))

# HOST=0.0.0.0 (./run.sh --lan) puts the contact pages on the wifi, so the
# family can write from their own phones. The Werkzeug debugger is a remote
# shell, so it does not go onto the network with them.
ON_WIFI = HOST not in ("127.0.0.1", "localhost", "::1")
TUNNELED = os.getenv("TUNNEL", "") == "1"
DEBUG = os.getenv("FLASK_DEBUG", "1") == "1" and not ON_WIFI and not TUNNELED

# A browser opens a camera only on a secure page, and on a phone that means
# https. SSL=1 (./run.sh --https) serves one with a certificate this machine
# signs itself - which both ends have to accept once. TUNNEL=1 (./run.sh
# --tunnel) leaves that to cloudflared, which fronts this with a certificate
# phones already trust - and which also means this is reachable from outside
# the house, so the debugger stays off there too.
HTTPS = os.getenv("SSL", "") in ("1", "on", "true")
CERT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "certs")
CERT = os.path.join(CERT_DIR, "ask-cert.pem")
CERT_KEY = os.path.join(CERT_DIR, "ask-key.pem")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_AUDIO_BYTES


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/health")
def health():
    """Tells the front end whether the local model has finished warming up."""
    return jsonify(
        ready=stt._model is not None,
        model=stt.MODEL_SIZE,
        has_key=bool(os.getenv("HACKCLUB_API_KEY")),
    )


@app.route("/api/weather")
def weather_now():
    """The same forecast the voice command opens, for a page reload."""
    try:
        return jsonify(weather.forecast())
    except weather.WeatherError as exc:
        log.error("weather failed: %s", exc)
        return jsonify(error="weather"), 502


def _event_error(exc, status):
    return jsonify(error="invalid_event" if status == 400 else "event_not_found",
                   message=str(exc)), status


@app.route("/api/events", methods=["GET", "POST"])
def calendar_events():
    """List or create local calendar events."""
    if request.method == "GET":
        return jsonify(events=events.list_all())

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify(error="invalid_event", message="Please provide event details."), 400
    try:
        event = events.create_event(data.get("title"), data.get("date"), data.get("time"))
    except events.EventValidationError as exc:
        return _event_error(exc, 400)
    return jsonify(event=event, events=events.list_all()), 201


@app.route("/api/events/<event_id>", methods=["PATCH", "DELETE"])
def calendar_event(event_id):
    """Update or delete one local calendar event."""
    try:
        if request.method == "DELETE":
            event = events.delete_event(event_id)
        else:
            data = request.get_json(silent=True)
            if not isinstance(data, dict):
                return jsonify(error="invalid_event", message="Please provide event details."), 400
            event = events.update_event(event_id, data)
    except events.EventValidationError as exc:
        return _event_error(exc, 400)
    except events.EventNotFoundError as exc:
        return _event_error(exc, 404)
    return jsonify(event=event, events=events.list_all())


def _medicine_error(exc, status):
    return jsonify(error="invalid_medicine" if status == 400 else "medicine_not_found",
                   message=str(exc)), status


@app.route("/api/medicines", methods=["GET", "POST"])
def medicine_schedule():
    """The whole schedule Medora keeps, or one more medicine in it."""
    if request.method == "GET":
        return jsonify(medicines.snapshot())

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify(error="invalid_medicine",
                       message="Please provide the medicine details."), 400
    try:
        medicine = medicines.create_medicine(
            data.get("name"), data.get("times"), data.get("days"),
            data.get("quantity"), data.get("container"),
        )
    except medicines.MedicineValidationError as exc:
        return _medicine_error(exc, 400)
    return jsonify(medicine=medicine, **medicines.snapshot()), 201


@app.route("/api/medicines/due")
def medicines_due():
    """Doses that came due in the last few minutes and are still waiting -
    what the assistant speaks a reminder for."""
    return jsonify(due=medicines.due_now())


@app.route("/api/medicines/<medicine_id>", methods=["DELETE"])
def medicine_entry(medicine_id):
    """Take one medicine out of the schedule."""
    try:
        removed = medicines.delete_medicine(medicine_id)
    except medicines.MedicineNotFoundError as exc:
        return _medicine_error(exc, 404)
    return jsonify(medicine=removed, **medicines.snapshot())


@app.route("/api/doses", methods=["POST"])
def medicine_doses():
    """Write down a dose as taken or skipped - pressed in the app, or
    relayed from the buttons on Medora itself."""
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify(error="invalid_dose", message="Nothing to write down."), 400

    try:
        dose = medicines.record_dose_result(
            data.get("container"),
            data.get("minute", data.get("occurrenceMinute")),
            data.get("status"),
        )
    except medicines.MedicineValidationError as exc:
        return jsonify(error="invalid_dose", message=str(exc)), 400
    return jsonify(dose=dose, **medicines.snapshot()), 201


@app.route("/api/news")
def news_stories():
    """The latest headlines, and what the senior is following."""
    category = request.args.get("category") or None
    if category and category not in news.BY_KEY:
        return jsonify(error="unknown_category",
                       message="There is no news section by that name."), 404

    try:
        found = news.stories([category] if category else None,
                             force=request.args.get("refresh") == "1")
    except news.NewsError as exc:
        log.error("news failed: %s", exc)
        return jsonify(error="news", message="The news could not be fetched."), 502

    return jsonify(stories=found, categories=news.catalogue(),
                   selected=news.selected(), category=category)


@app.route("/api/news/settings", methods=["POST"])
def news_settings():
    """Replace the sections being followed."""
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify(error="invalid_categories",
                       message="Please choose at least one kind of news."), 400
    try:
        news.save_categories(data.get("categories"))
    except news.NewsValidationError as exc:
        return jsonify(error="invalid_categories", message=str(exc)), 400

    return jsonify(categories=news.catalogue(), selected=news.selected())


def _message_error(exc, status):
    return jsonify(error="invalid_message" if status == 400 else "contact_not_found",
                   message=str(exc)), status


@app.route("/<contact_slug>")
def contact_page(contact_slug):
    """The other end of a conversation - /grandson, /son, /nephew, and so on."""
    contact = messages.find_contact(contact_slug)
    if contact is None:
        known = ", ".join("/" + c["slug"] for c in messages.CONTACTS)
        return f"No contact page by that name. Try: {known}", 404
    return render_template("contact.html", contact=contact, contacts=messages.CONTACTS)


@app.route("/api/contacts")
def message_contacts():
    """Every contact with its last message, for the list and the dock badge."""
    return jsonify(contacts=messages.overview())


@app.route("/api/messages/<contact_slug>", methods=["GET", "POST"])
def message_thread(contact_slug):
    """Read one conversation, or add a message to it."""
    viewer = (request.args.get("as") or messages.SENIOR).strip().lower()
    if viewer not in messages.SENDERS:
        return jsonify(error="invalid_message",
                       message="Read a conversation as the senior or the contact."), 400

    try:
        if request.method == "GET":
            return jsonify(messages=messages.thread(contact_slug, viewer))

        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify(error="invalid_message",
                           message="Please write a message first."), 400
        message = messages.send(contact_slug, data.get("from") or viewer,
                                data.get("text"))
    except messages.MessageValidationError as exc:
        return _message_error(exc, 400)
    except messages.ContactNotFoundError as exc:
        return _message_error(exc, 404)

    # Read it back as whoever just wrote - they have plainly seen their own
    # conversation, and the other end's unread count is not theirs to clear.
    return jsonify(message=message,
                   messages=messages.thread(contact_slug, message["from"])), 201


def _viewer(value):
    """The end of a conversation a request speaks for, or None."""
    viewer = (value or messages.SENIOR).strip().lower()
    return viewer if viewer in messages.SENDERS else None


@app.route("/api/ice")
def ice_servers():
    """Where a browser should look for the other end of a call."""
    return jsonify(iceServers=calls.ice_servers())


@app.route("/api/calls", methods=["GET", "POST"])
def video_calls():
    """Carry the introductions two browsers need to open a video call.

    Only the offer, the answer, and the network candidates pass through here.
    The picture and the sound go straight between the two browsers.
    """
    if request.method == "GET":
        viewer = _viewer(request.args.get("as"))
        if viewer is None:
            return jsonify(error="invalid_call", message="Unknown caller."), 400

        slug = request.args.get("slug")
        if slug is not None:
            contact = messages.find_contact(slug)
            if contact is None:
                return jsonify(error="contact_not_found",
                               message="There is no contact by that name."), 404
            slug = contact["slug"]

        try:
            since = int(request.args.get("since") or 0)
        except ValueError:
            since = 0

        call, signals, cursor = calls.poll(viewer, slug, since)
        return jsonify(call=call, signals=signals, cursor=cursor)

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify(error="invalid_call", message="Nothing to do."), 400

    viewer = _viewer(data.get("as"))
    if viewer is None:
        return jsonify(error="invalid_call", message="Unknown caller."), 400

    slug = data.get("slug")
    action = (data.get("action") or "").strip().lower()

    try:
        if action == "start":
            call = calls.place(slug, viewer)
        elif action == "answer":
            call = calls.answer(slug, viewer)
        elif action == "end":
            call = calls.end(slug, viewer, data.get("reason"))
        elif action == "signal":
            call = calls.signal(slug, viewer, data.get("kind"), data.get("data"))
        else:
            return jsonify(error="invalid_call", message="Unknown call action."), 400
    except messages.ContactNotFoundError as exc:
        return jsonify(error="contact_not_found", message=str(exc)), 404
    except calls.CallBusy as exc:
        return jsonify(error="busy", message=str(exc)), 409
    except calls.CallNotFound as exc:
        return jsonify(error="no_call", message=str(exc)), 404
    except calls.CallError as exc:
        return jsonify(error="invalid_call", message=str(exc)), 400

    return jsonify(call=call)


def _news_reply(kind, category, question):
    """One spoken answer about the news, and where the window should land."""
    def reply(speak, **extra):
        return jsonify(action="news", question=question, speak=speak, **extra)

    if kind == "settings":
        return jsonify(action="news-settings", question=question,
                       speak="Here are your news settings. "
                             "Pick the kinds of news you'd like to hear.")

    if kind == "following":
        return reply(news.following_line())

    if kind == "more":
        story = news.current_story()
        return reply(news.story_line(story), story=story)

    if kind == "next":
        story = news.advance()
        if not story:
            return reply(news.exhausted_line())
        return reply(news.story_line(story, "Next story. "), story=story)

    if kind == "repeat":
        found, read_category = news.last_read()
        return reply(news.headlines_line(found[:news.HEADLINE_COUNT], read_category),
                     category=read_category)

    # headlines, a section, opening the window, or a forced refresh
    try:
        found = news.stories([category] if category else None,
                             force=(kind == "refresh"))
    except news.NewsError as exc:
        log.error("news failed: %s", exc)
        return jsonify(error="news", question=question,
                       speak="I can't reach the news just now. "
                             "Please try again in a moment."), 502

    top = found[:news.HEADLINE_COUNT]
    news.begin_reading(top, category)

    if kind == "open":
        return reply("Here's the news.", category=category)
    return reply(news.headlines_line(top, category), category=category)


@app.route("/api/ask", methods=["POST"])
def ask():
    clip = request.files.get("audio")
    if clip is None:
        return jsonify(error="no_audio", speak="I didn't catch that. Please try again."), 400

    audio = clip.read()
    log.info("upload: %d bytes, mimetype=%r, filename=%r",
             len(audio), clip.mimetype, clip.filename)
    if len(audio) < 1024:
        return jsonify(error="empty", speak="I didn't hear anything. Please try again.")

    try:
        heard = stt.transcribe(audio)
    except Exception:
        log.exception("transcription failed")
        return jsonify(error="stt", speak="I had trouble hearing you. Please try again."), 500

    log.info("heard: %r (peak=%.4f over %.2fs)", heard.text, heard.peak, heard.seconds)

    # A dead microphone and a silent room need different advice.
    if heard.peak < stt.SILENCE_PEAK:
        return jsonify(
            error="no_signal",
            speak="I can't hear your microphone. Please check that it is turned on.",
        )
    if not heard.text:
        return jsonify(error="silence", speak="I didn't hear a question. Please try again.")

    question = heard.text

    # "Play Simon" is ours to handle - don't spend a model call on it.
    game = intents.match_game(question)
    if game:
        key, label = game
        log.info("opening game %r", key)
        return jsonify(action="game", game=key, question=question,
                       speak=f"Opening {label}.")

    # So is the forecast - a lookup the model would only slow down.
    if intents.match_weather(question):
        log.info("opening weather")
        try:
            report = weather.forecast()
        except weather.WeatherError as exc:
            log.error("weather failed: %s", exc)
            return jsonify(error="weather", question=question,
                           speak="I can't get the forecast just now. "
                                 "Please try again in a moment."), 502
        return jsonify(action="weather", weather=report, question=question,
                       speak=report["speak"])

    # Medora's schedule is ours too - a lookup in a local file, and the
    # window is the answer as much as the spoken line is.
    medora = intents.match_medora(question)
    if medora:
        log.info("medora: %s", medora)

        # The dispenser is on the other end of the browser's Bluetooth link,
        # so the front end runs the test; all this can do is ask for it.
        if medora == "test":
            return jsonify(action="medora-test", question=question,
                           speak="Testing Medora now.")

        speak = (medicines.upcoming_doses_line() if medora == "list"
                 else medicines.next_dose_line())
        return jsonify(action="medora", medora=medicines.snapshot(),
                       question=question, speak=speak)

    # The news is ours as well: reading a few RSS feeds, not a question.
    heard_news = intents.match_news(question)
    if heard_news:
        kind, category = heard_news
        # "tell me more", "next story" and "say that again" only belong to
        # the news while something is actually being read out. On their own
        # they follow whatever was last said, which is the model's business.
        if kind in ("more", "next", "repeat") and not news.reading_active():
            heard_news = None
        else:
            log.info("news: %s%s", kind, f" ({category})" if category else "")
            return _news_reply(kind, category, question)

    try:
        reply, searched = brain.answer(question)
    except brain.BrainError as exc:
        log.error("brain failed: %s", exc)
        if str(exc) == "rate limited":
            speak = "I need a short rest. Please try again in a few minutes."
        else:
            speak = "I'm having trouble thinking right now. Please try again in a moment."
        return jsonify(error="brain", speak=speak), 502

    log.info("said: %r%s", reply, " (searched)" if searched else "")
    return jsonify(question=question, speak=reply, searched=searched)


def _warm_up():
    """Load Whisper in the background so the first question isn't slow."""
    try:
        stt.load_model()
    except Exception:
        log.exception("could not preload whisper model")


def _lan_ip():
    """This machine's address on the local network, or None if it has none."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # Nothing is sent - this only asks the routing table which interface
        # would carry a packet out, which is the address a phone can reach.
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return None
    finally:
        sock.close()


def _certificate(ip):
    """Return (cert, key) for a self-signed certificate covering this machine.

    Made once with openssl and kept in certs/, so a phone that has accepted
    the warning does not have to accept a new one at every restart. The
    address has to be in the certificate itself - a browser will not look at
    the common name any more.
    """
    if _certificate_covers(ip):
        return CERT, CERT_KEY

    os.makedirs(CERT_DIR, exist_ok=True)
    config = os.path.join(CERT_DIR, "openssl.cnf")
    with open(config, "w", encoding="utf-8") as f:
        f.write(
            "[req]\ndistinguished_name = dn\nx509_extensions = ext\nprompt = no\n"
            "[dn]\nCN = Ask\n"
            "[ext]\nsubjectAltName = @alt\nbasicConstraints = CA:FALSE\n"
            f"[alt]\nIP.1 = 127.0.0.1\nDNS.1 = localhost\n"
            + (f"IP.2 = {ip}\n" if ip and ip != "127.0.0.1" else "")
        )

    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "365",
         "-keyout", CERT_KEY, "-out", CERT, "-config", config],
        check=True, capture_output=True,
    )
    os.chmod(CERT_KEY, 0o600)
    log.info("made a certificate for %s (accept it once in each browser)",
             ip or "this machine")
    return CERT, CERT_KEY


def _certificate_covers(ip):
    """True if the certificate on disk is still good for this address."""
    if not (os.path.exists(CERT) and os.path.exists(CERT_KEY)):
        return False
    try:
        out = subprocess.run(["openssl", "x509", "-in", CERT, "-noout", "-text",
                              "-checkend", "86400"],
                             check=True, capture_output=True, text=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return False
    return not ip or ip == "127.0.0.1" or f"IP Address:{ip}" in out


def _banner(scheme):
    """Print the addresses to open, including the one to type on a phone."""
    log.info("Ask is at %s://127.0.0.1:%d", scheme, PORT)
    if TUNNELED:
        log.info("Opening a Cloudflare tunnel - the link for phones follows "
                 "in a moment.")
        return
    if not ON_WIFI:
        log.info("To write messages from a phone, start it with ./run.sh --lan")
        return

    ip = _lan_ip()
    if not ip:
        log.warning("This machine has no address on the network - "
                    "a phone will not be able to reach it.")
        return

    log.info("On the same wifi, open one of these on a phone:")
    for contact in messages.CONTACTS:
        log.info("    %-14s %s://%s:%d/%s",
                 f"{contact['name']} ({contact['relation'].lower()})",
                 scheme, ip, PORT, contact["slug"])

    if scheme == "https":
        log.info("The certificate is this machine's own, so each browser asks "
                 "once whether to trust it. Say yes and the camera works.")
    else:
        log.info("Messages work as they are. A video call from the phone needs "
                 "a camera, and a browser only opens one on a secure page - "
                 "restart with ./run.sh --lan --https for that.")


if __name__ == "__main__":
    # With the reloader on, only the child process should load the model -
    # otherwise it is held in memory twice.
    ssl_context = None
    if HTTPS:
        try:
            ssl_context = _certificate(_lan_ip())
        except (OSError, subprocess.CalledProcessError) as exc:
            log.error("could not make a certificate (%s) - falling back to http, "
                      "so the camera will not open on a phone", exc)

    if not DEBUG or os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        threading.Thread(target=_warm_up, daemon=True).start()
        _banner("https" if ssl_context else "http")
    app.run(host=HOST, port=PORT, debug=DEBUG, ssl_context=ssl_context)
