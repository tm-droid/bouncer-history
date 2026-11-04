/**
 * Weather each historical match was played in, from the Open-Meteo archive (CC BY 4.0: the app
 * shows "Weather data: Open-Meteo.com").
 *
 * `w` on a match file, and the value in `idx/weather.json`, is `[tmax, rain, humidity, wind, cloud]`:
 *   tmax      hottest daytime temperature over the match's days, 0.1 C (temperature_2m_max)
 *   rain      total precipitation over the days, 0.1 mm (precipitation_sum)
 *   humidity  mean relative humidity, whole % (relative_humidity_2m_mean)
 *   wind      strongest wind at 10 m, whole km/h (wind_speed_10m_max)
 *   cloud     mean cloud cover, whole % (cloud_cover_mean)
 * Positions are the schema; append, never reorder. A match with any variable missing has no `w`.
 */

import { ARCHIVE_URL, RateLimited } from "./openmeteo.mjs";

export const DAILY = "temperature_2m_max,precipitation_sum,relative_humidity_2m_mean,wind_speed_10m_max,cloud_cover_mean";
/** A request spanning at most this many days is one call against Open-Meteo's allowance. */
export const WINDOW_DAYS = 14;
/** The archive trails real time by a few days; asking sooner returns nulls. */
export const ARCHIVE_LAG_DAYS = 6;
const DAY_MS = 86_400_000;

const dayOf = (date) => Date.parse(`${date}T00:00:00Z`);
const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The match's last day: `ds` consecutive days from `d`. */
export function endDate(d, ds) {
  return isoOf(dayOf(d) + (Math.max(1, ds || 1) - 1) * DAY_MS);
}

const nums = (list) => (list ?? []).filter((v) => typeof v === "number" && Number.isFinite(v));
const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;

/** The `daily` block of an archive answer, cut to `days` and folded into one `w`; null when any variable has no value. */
export function weatherOf(daily, days) {
  if (!daily?.time) return null;
  const at = days.map((d) => daily.time.indexOf(d)).filter((i) => i >= 0);
  const col = (name) => nums(at.map((i) => daily[name]?.[i]));
  const [t, r, h, wd, c] = ["temperature_2m_max", "precipitation_sum", "relative_humidity_2m_mean", "wind_speed_10m_max", "cloud_cover_mean"].map(col);
  if ([t, r, h, wd, c].some((l) => l.length === 0)) return null;
  const sum = (l) => l.reduce((a, b) => a + b, 0);
  const mean = (l) => sum(l) / l.length;
  return [round(Math.max(...t), 1), round(sum(r), 1), Math.round(mean(h)), Math.round(Math.max(...wd)), Math.round(mean(c))];
}

/** Every day from `start` to `end`, inclusive. */
export function daysBetween(start, end) {
  const out = [];
  for (let t = dayOf(start); t <= dayOf(end); t += DAY_MS) out.push(isoOf(t));
  return out;
}

/**
 * Pending matches grouped so that one request serves many: same ground, every day inside one
 * `WINDOW_DAYS` span. Newest windows first, because those are the matches people open.
 * @param {{id: string, key: string, start: string, end: string}[]} pending
 */
export function windowsOf(pending) {
  const byGround = new Map();
  for (const m of pending) (byGround.get(m.key) ?? byGround.set(m.key, []).get(m.key)).push(m);
  const windows = [];
  for (const [key, list] of byGround) {
    list.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
    let current = null;
    for (const m of list) {
      if (current && dayOf(m.end) - dayOf(current.start) < WINDOW_DAYS * DAY_MS) {
        current.matches.push(m);
        if (m.end > current.end) current.end = m.end;
      } else {
        current = { key, start: m.start, end: m.end, matches: [m] };
        windows.push(current);
      }
    }
  }
  return windows.sort((a, b) => b.end.localeCompare(a.end) || a.key.localeCompare(b.key));
}

/**
 * Fetch weather for the matches `have` lacks, at most `cap` calls. Never throws: a rate limit
 * stops the run, an error skips that window, and five errors in a row stop it.
 *
 * @param {{id: string, key: string, start: string, end: string}[]} matches
 * @param {Map<string, number[]>} have   id -> w, from the published site and/or a local cache
 * @param {Map<string, [number, number]>} coords   ground key -> [lat, lon]
 * @returns {{weather: Map<string, number[]>, calls: number, fetched: number, stopped: string|null}}
 */
export async function fillWeather({ matches, have, coords, getJson, cap, today = new Date().toISOString().slice(0, 10), log = () => {} }) {
  const cutoff = isoOf(dayOf(today) - ARCHIVE_LAG_DAYS * DAY_MS);
  const pending = matches.filter((m) => !have.has(m.id) && coords.has(m.key) && m.end <= cutoff);
  const windows = windowsOf(pending);
  const weather = new Map();
  let calls = 0;
  let fetched = 0;
  let stopped = null;
  let failures = 0;
  log(`${pending.length} matches without weather in ${windows.length} requests (cap ${cap})`);
  for (const w of windows) {
    if (calls >= cap) {
      stopped = "cap";
      break;
    }
    const [lat, lon] = coords.get(w.key);
    calls++;
    try {
      const body = await getJson(`${ARCHIVE_URL}?latitude=${lat}&longitude=${lon}&start_date=${w.start}&end_date=${w.end}&daily=${DAILY}&timezone=auto`);
      failures = 0;
      for (const m of w.matches) {
        const value = weatherOf(body?.daily, daysBetween(m.start, m.end));
        if (value) {
          weather.set(m.id, value);
          fetched++;
        }
      }
    } catch (e) {
      if (e instanceof RateLimited) {
        stopped = "rate limited";
        break;
      }
      if (++failures >= 5) {
        stopped = `errors: ${e?.message}`;
        break;
      }
    }
  }
  return { weather, calls, fetched, stopped };
}

/** A `w` as published: five finite numbers. Anything else in a cache is dropped. */
export const validWeather = (w) => Array.isArray(w) && w.length >= 5 && w.slice(0, 5).every((v) => typeof v === "number" && Number.isFinite(v));

/**
 * The previous build is the cache: the weekly runner starts empty, but the site it last published
 * holds every answer already paid for. Each file fails alone (a first build has neither).
 * @returns {Promise<{weather: Map<string, number[]>, venueRows: unknown}>}
 */
export async function loadPublished({ baseUrl, fetchImpl = fetch }) {
  const get = async (rel) => {
    try {
      const res = await fetchImpl(baseUrl + rel, { signal: AbortSignal.timeout(60_000) });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  };
  const [w, venueRows] = await Promise.all([get("idx/weather.json"), get("idx/venues.json")]);
  const weather = new Map();
  if (w && typeof w === "object" && !Array.isArray(w)) for (const [id, v] of Object.entries(w)) if (validWeather(v)) weather.set(id, v.slice(0, 5));
  return { weather, venueRows };
}

/** Union of caches; later maps win. */
export function mergeWeather(...maps) {
  const out = new Map();
  for (const m of maps) for (const [id, w] of m) out.set(id, w);
  return out;
}
