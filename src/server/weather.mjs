import { HttpError } from './store.mjs';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const TTL = 15 * 60 * 1000;

const CODES = {
  0: ['Clear', 'clear', 'sun'],
  1: ['Mostly clear', 'mostly clear', 'sun-cloud'],
  2: ['Partly cloudy', 'partly cloudy', 'sun-cloud'],
  3: ['Overcast', 'cloudy', 'cloud'],
  45: ['Fog', 'foggy', 'fog'],
  48: ['Freezing fog', 'foggy with freezing fog', 'fog'],
  51: ['Light drizzle', 'lightly drizzly', 'drizzle'],
  53: ['Drizzle', 'drizzly', 'drizzle'],
  55: ['Heavy drizzle', 'heavily drizzly', 'rain'],
  56: ['Freezing drizzle', 'freezing drizzle', 'drizzle'],
  57: ['Freezing drizzle', 'freezing drizzle', 'drizzle'],
  61: ['Light rain', 'lightly rainy', 'drizzle'],
  63: ['Rain', 'rainy', 'rain'],
  65: ['Heavy rain', 'heavy rain', 'rain'],
  66: ['Freezing rain', 'freezing rain', 'rain'],
  67: ['Freezing rain', 'freezing rain', 'rain'],
  71: ['Light snow', 'lightly snowy', 'snow'],
  73: ['Snow', 'snowy', 'snow'],
  75: ['Heavy snow', 'heavy snow', 'snow'],
  77: ['Snow grains', 'snowy', 'snow'],
  80: ['Showers', 'showery', 'drizzle'],
  81: ['Showers', 'showery', 'rain'],
  82: ['Heavy showers', 'heavy showers', 'rain'],
  85: ['Snow showers', 'snow showers', 'snow'],
  86: ['Snow showers', 'heavy snow showers', 'snow'],
  95: ['Thunderstorms', 'thundery', 'storm'],
  96: ['Thunderstorms', 'thundery with hail', 'storm'],
  99: ['Thunderstorms', 'thundery with hail', 'storm'],
};
const UNKNOWN = ['Unsettled', 'unsettled', 'cloud'];
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const cache = new Map();

async function where(context) {
  const geo = context && context.geo;
  if (geo && geo.latitude != null && geo.longitude != null) {
    return {
      lat: geo.latitude, lon: geo.longitude,
      city: geo.city || 'your area',
      region: (geo.subdivision && geo.subdivision.name) || '',
      tz: geo.timezone || 'auto',
    };
  }
  const res = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`ipinfo ${res.status}`);
  const data = await res.json();
  const [lat, lon] = (data.loc || '').split(',');
  if (!lat || !lon) throw new Error('no coordinates for this location');
  return { lat, lon, city: data.city || 'your area', region: data.region || '', tz: data.timezone || 'auto' };
}

const round = (v, fallback = 0) => (v == null ? fallback : Math.round(v));

function todayLine(place, today, nowTemp) {
  const parts = [
    `Today in ${place} it's ${today.spoken}, with a high of ${today.high} and a low of ` +
    `${today.low}. Right now it's ${nowTemp} degrees.`,
  ];
  if (today.rain >= 20) {
    let rain = `There's a ${today.rain} percent chance of rain`;
    if (today.precip >= 0.1) rain += `, around ${today.precip.toFixed(1)} of an inch`;
    parts.push(`${rain}.`);
  }
  if (today.wind >= 20) parts.push(`It'll be breezy, with winds up to ${today.wind} miles an hour.`);
  parts.push('The week ahead is on your screen.');
  return parts.join(' ');
}

function shape(here, raw) {
  const daily = raw.daily;
  const current = raw.current || {};
  const days = daily.time.map((stamp, i) => {
    const date = new Date(`${stamp}T00:00:00Z`);
    const [text, spoken, icon] = CODES[daily.weather_code[i]] || UNKNOWN;
    return {
      date: stamp,
      label: i === 0 ? 'Today' : SHORT_DAYS[date.getUTCDay()],
      weekday: LONG_DAYS[date.getUTCDay()],
      text, spoken, icon,
      high: round(daily.temperature_2m_max[i]),
      low: round(daily.temperature_2m_min[i]),
      rain: round(daily.precipitation_probability_max[i]),
      precip: Math.round((daily.precipitation_sum[i] || 0) * 100) / 100,
      wind: round(daily.wind_speed_10m_max[i]),
    };
  });
  const [nowText, , nowIcon] = CODES[current.weather_code] || UNKNOWN;
  const nowTemp = round(current.temperature_2m, days[0].high);
  return {
    place: here.city,
    region: here.region,
    now: { temp: nowTemp, text: nowText, icon: nowIcon, humidity: round(current.relative_humidity_2m) },
    days,
    speak: todayLine(here.city, days[0], nowTemp),
  };
}

export async function forecast(context) {
  let here;
  try {
    here = await where(context);
  } catch (error) {
    throw new HttpError(502, 'weather', `weather location failed: ${error.message}`);
  }
  const key = `${Number(here.lat).toFixed(1)},${Number(here.lon).toFixed(1)}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL) return cached.report;

  try {
    const params = new URLSearchParams({
      latitude: here.lat, longitude: here.lon,
      current: 'temperature_2m,relative_humidity_2m,weather_code',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,' +
             'precipitation_sum,wind_speed_10m_max',
      temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch',
      timezone: here.tz, forecast_days: '7',
    });
    const res = await fetch(`${FORECAST_URL}?${params}`, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`open-meteo ${res.status}`);
    const report = shape(here, await res.json());
    cache.set(key, { at: Date.now(), report });
    return report;
  } catch (error) {
    if (cached) return cached.report;
    throw new HttpError(502, 'weather', error.message);
  }
}
