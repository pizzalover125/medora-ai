"""The forecast, answered without the model.

Location comes from the caller's network, the forecast from Open-Meteo. No
API key, no account. The spoken line covers today only - the window shows the
whole week, which is a lot to listen to but nothing to look at.
"""

import datetime
import logging
import threading
import time

import requests

log = logging.getLogger(__name__)

GEO_URL = "https://ipinfo.io/json"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
TIMEOUT = 12
TTL = 15 * 60          # the sky does not change fast enough to refetch sooner

# WMO code -> (shown, spoken, icon). The two texts differ where the official
# wording reads badly out loud: "Overcast" is fine on screen, "cloudy" is what
# a person says.
CODES = {
    0:  ("Clear", "clear", "sun"),
    1:  ("Mostly clear", "mostly clear", "sun-cloud"),
    2:  ("Partly cloudy", "partly cloudy", "sun-cloud"),
    3:  ("Overcast", "cloudy", "cloud"),
    45: ("Fog", "foggy", "fog"),
    48: ("Freezing fog", "foggy with freezing fog", "fog"),
    51: ("Light drizzle", "lightly drizzly", "drizzle"),
    53: ("Drizzle", "drizzly", "drizzle"),
    55: ("Heavy drizzle", "heavily drizzly", "rain"),
    56: ("Freezing drizzle", "freezing drizzle", "drizzle"),
    57: ("Freezing drizzle", "freezing drizzle", "drizzle"),
    61: ("Light rain", "lightly rainy", "drizzle"),
    63: ("Rain", "rainy", "rain"),
    65: ("Heavy rain", "heavy rain", "rain"),
    66: ("Freezing rain", "freezing rain", "rain"),
    67: ("Freezing rain", "freezing rain", "rain"),
    71: ("Light snow", "lightly snowy", "snow"),
    73: ("Snow", "snowy", "snow"),
    75: ("Heavy snow", "heavy snow", "snow"),
    77: ("Snow grains", "snowy", "snow"),
    80: ("Showers", "showery", "drizzle"),
    81: ("Showers", "showery", "rain"),
    82: ("Heavy showers", "heavy showers", "rain"),
    85: ("Snow showers", "snow showers", "snow"),
    86: ("Snow showers", "heavy snow showers", "snow"),
    95: ("Thunderstorms", "thundery", "storm"),
    96: ("Thunderstorms", "thundery with hail", "storm"),
    99: ("Thunderstorms", "thundery with hail", "storm"),
}
UNKNOWN = ("Unsettled", "unsettled", "cloud")

_cache = None
_cache_at = 0.0
_lock = threading.Lock()


class WeatherError(RuntimeError):
    """The forecast could not be fetched."""


def _where():
    """Approximate location from the public IP. Good enough for a forecast."""
    resp = requests.get(GEO_URL, timeout=TIMEOUT)
    resp.raise_for_status()
    data = resp.json()
    lat, _, lon = (data.get("loc") or "").partition(",")
    if not lat or not lon:
        raise WeatherError("no coordinates for this location")
    return {
        "lat": lat,
        "lon": lon,
        "city": data.get("city") or "your area",
        "region": data.get("region") or "",
        "tz": data.get("timezone") or "auto",
    }


def _fetch():
    here = _where()
    resp = requests.get(FORECAST_URL, timeout=TIMEOUT, params={
        "latitude": here["lat"],
        "longitude": here["lon"],
        "current": "temperature_2m,relative_humidity_2m,weather_code",
        "daily": ("weather_code,temperature_2m_max,temperature_2m_min,"
                  "precipitation_probability_max,precipitation_sum,"
                  "wind_speed_10m_max"),
        "temperature_unit": "fahrenheit",
        "wind_speed_unit": "mph",
        "precipitation_unit": "inch",
        "timezone": here["tz"],
        "forecast_days": 7,
    })
    resp.raise_for_status()
    return here, resp.json()


def _round(value, fallback=0):
    return fallback if value is None else int(round(value))


def _shape(here, raw):
    daily = raw["daily"]
    current = raw.get("current") or {}
    today = datetime.date.fromisoformat(daily["time"][0])

    days = []
    for i, stamp in enumerate(daily["time"]):
        date = datetime.date.fromisoformat(stamp)
        shown, spoken, icon = CODES.get(daily["weather_code"][i], UNKNOWN)
        days.append({
            "date": stamp,
            "label": "Today" if date == today else date.strftime("%a"),
            "weekday": date.strftime("%A"),
            "text": shown,
            "spoken": spoken,
            "icon": icon,
            "high": _round(daily["temperature_2m_max"][i]),
            "low": _round(daily["temperature_2m_min"][i]),
            "rain": _round(daily["precipitation_probability_max"][i]),
            "precip": round(daily["precipitation_sum"][i] or 0, 2),
            "wind": _round(daily["wind_speed_10m_max"][i]),
        })

    now_shown, _, now_icon = CODES.get(current.get("weather_code"), UNKNOWN)
    place = here["city"]

    return {
        "place": place,
        "region": here["region"],
        "now": {
            "temp": _round(current.get("temperature_2m"), days[0]["high"]),
            "text": now_shown,
            "icon": now_icon,
            "humidity": _round(current.get("relative_humidity_2m")),
        },
        "days": days,
        "speak": _today_line(place, days[0], _round(current.get("temperature_2m"),
                                                    days[0]["high"])),
    }


def _today_line(place, today, now_temp):
    """What gets read aloud: today, and only today."""
    parts = [
        f"Today in {place} it's {today['spoken']}, "
        f"with a high of {today['high']} and a low of {today['low']}. "
        f"Right now it's {now_temp} degrees."
    ]

    # Below about one chance in five, mentioning rain only worries people.
    if today["rain"] >= 20:
        rain = f"There's a {today['rain']} percent chance of rain"
        if today["precip"] >= 0.1:
            rain += f", around {today['precip']:.1f} of an inch"
        parts.append(rain + ".")

    if today["wind"] >= 20:
        parts.append(f"It'll be breezy, with winds up to {today['wind']} miles an hour.")

    parts.append("The week ahead is on your screen.")
    return " ".join(parts)


def forecast(force=False):
    """The shaped forecast, cached for a quarter of an hour."""
    global _cache, _cache_at

    with _lock:
        fresh = _cache and not force and (time.time() - _cache_at) < TTL
        if fresh:
            return _cache

        try:
            here, raw = _fetch()
            _cache = _shape(here, raw)
            _cache_at = time.time()
        except WeatherError:
            raise
        except Exception as exc:
            # A stale forecast beats no forecast; the sky rarely turns over in
            # the time it takes an outage to pass.
            if _cache:
                log.warning("weather refresh failed (%s); serving cached", exc)
                return _cache
            raise WeatherError(str(exc)) from exc

        return _cache
