/**
 * Coordinates for the grounds in `idx/venues.json`: Wikidata first (a cricket ground's own P625,
 * CC0), else Open-Meteo's geocoding of the city. Wikidata's point is used only when it agrees
 * with the city (within CITY_RADIUS_KM) or there is no city to contradict it, because many grounds
 * share a name ("County Ground", "Victoria Park").
 *
 * A failed Wikidata query resolves everything by city; a failed geocode leaves the ground without
 * coordinates, which only means no weather for its matches this week.
 */

import fs from "node:fs";
import path from "node:path";
import { squash, venueName } from "./names.js";
import { chooseCandidate, distanceKm, GEOCODE_URL, RateLimited } from "./openmeteo.mjs";

const SPARQL_URL = "https://query.wikidata.org/sparql";
const USER_AGENT = "BouncerHistoryBuilder/1.0 (https://github.com/tm-droid/bouncer-history; malhotra.tanush@gmail.com)";
export const CACHE_FILE = "wikidata-grounds-cache.json";
export const CACHE_MAX_AGE_MS = 6 * 24 * 3600 * 1000;
export const CITY_RADIUS_KM = 100;

// Q682943 "cricket field" and its subclasses, or any venue whose sport is cricket (Q5375).
const QUERY = `SELECT ?i ?l ?c WHERE {
  { ?i wdt:P31/wdt:P279* wd:Q682943 } UNION { ?i wdt:P641 wd:Q5375 }
  ?i wdt:P625 ?c.
  { ?i rdfs:label ?l } UNION { ?i skos:altLabel ?l }
  FILTER(LANG(?l) = "en")
}`;

/** SPARQL bindings to Map(squashed label -> [{id, lat, lon}]). */
export function groundsByName(json) {
  const out = new Map();
  for (const b of json?.results?.bindings ?? []) {
    const m = /^Point\((-?[\d.]+) (-?[\d.]+)\)$/.exec(b.c?.value ?? "");
    const id = b.i?.value;
    const key = squash(b.l?.value);
    if (!m || !id || !key) continue;
    const lat = Number(m[2]);
    const lon = Number(m[1]);
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) continue;
    const list = out.get(key) ?? out.set(key, []).get(key);
    if (!list.some((g) => g.id === id)) list.push({ id, lat, lon });
  }
  return out;
}

/** The Wikidata grounds, from a cache under 6 days old, else a query; null when the query fails. */
export async function loadGrounds({ cacheDir = null, fetchImpl = fetch, now = Date.now() } = {}) {
  const file = cacheDir ? path.join(cacheDir, CACHE_FILE) : null;
  try {
    if (file && fs.existsSync(file) && now - fs.statSync(file).mtimeMs < CACHE_MAX_AGE_MS) {
      return groundsByName(JSON.parse(fs.readFileSync(file, "utf8")));
    }
  } catch {
    // An unreadable cache is a cache miss.
  }
  try {
    const res = await fetchImpl(`${SPARQL_URL}?query=${encodeURIComponent(QUERY)}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/sparql-results+json" },
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (file) {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(json));
    }
    return groundsByName(json);
  } catch (e) {
    console.error(`Wikidata grounds unavailable, geocoding by city only: ${e?.message}`);
    return null;
  }
}

/** "Wankhede Stadium, Mumbai" with no city field reads as Mumbai. */
export function placeOf(venue) {
  if (venue.city) return venue.city;
  const parts = String(venue.name ?? "").split(",");
  return parts.length > 1 ? parts[parts.length - 1].trim() || null : null;
}

/** One city through Open-Meteo's geocoder; null when it knows no such place. Throws RateLimited. */
export async function geocodeCity(getJson, place, teams) {
  const body = await getJson(`${GEOCODE_URL}?name=${encodeURIComponent(place)}&count=10`);
  const hit = chooseCandidate(body?.results, teams ?? new Map());
  return hit ? [hit.latitude, hit.longitude] : null;
}

const round3 = (v) => Math.round(v * 1000) / 1000;

/**
 * @param {{key: string, name: string, city: string|null, teams: Map<string, number>}[]} venues
 * @param {Map<string, {lat: number, lon: number, src: string}>} previous  last published coordinates
 * @param {Map<string, {id: string, lat: number, lon: number}[]>|null} grounds
 * @param {(place: string, teams: Map<string, number>) => Promise<[number, number]|null>} geocode
 * @returns {Promise<Map<string, {lat: number, lon: number, src: "w"|"c"}>>}
 */
export async function resolveVenues({ venues, previous = new Map(), grounds, geocode, maxGeocodes = 1500 }) {
  const out = new Map();
  const cityCache = new Map(); // place + team signature -> point, so one city is asked once
  let geocodes = 0;
  let limited = false;
  const city = async (v) => {
    const place = placeOf(v);
    if (!place) return null;
    const prior = previous.get(v.key);
    if (prior?.src === "c") return [prior.lat, prior.lon];
    const cacheKey = `${squash(place)}|${[...v.teams.keys()].sort().join(",")}`;
    if (cityCache.has(cacheKey)) return cityCache.get(cacheKey);
    if (limited || geocodes >= maxGeocodes) return null;
    geocodes++;
    let point = null;
    try {
      point = await geocode(place, v.teams);
    } catch (e) {
      if (e instanceof RateLimited) limited = true;
    }
    cityCache.set(cacheKey, point);
    return point;
  };
  for (const v of venues) {
    const prior = previous.get(v.key);
    if (prior?.src === "w") {
      out.set(v.key, prior);
      continue;
    }
    const point = await city(v);
    const names = new Set([venueName(v.name), squash(v.name)]);
    const found = new Map();
    for (const n of names) for (const g of grounds?.get(n) ?? []) found.set(g.id, g);
    let candidates = [...found.values()];
    if (point && candidates.length) {
      candidates = candidates.filter((g) => distanceKm(point, [g.lat, g.lon]) <= CITY_RADIUS_KM);
    }
    // Several same-named grounds and nothing to tell them apart: guessing is worse than the city.
    const wd = candidates.length === 1 || (candidates.length > 1 && point) ? closest(candidates, point) : null;
    if (wd) out.set(v.key, { lat: round3(wd.lat), lon: round3(wd.lon), src: "w" });
    else if (point) out.set(v.key, { lat: round3(point[0]), lon: round3(point[1]), src: "c" });
  }
  return out;
}

function closest(list, point) {
  if (list.length === 1 || !point) return list[0];
  return list.reduce((a, b) => (distanceKm(point, [a.lat, a.lon]) <= distanceKm(point, [b.lat, b.lon]) ? a : b));
}

/** `idx/venues.json` rows `[key, name, city, matches, lat?, lon?, src?]` to Map(key -> {lat, lon, src}). */
export function coordsFromRows(rows) {
  const out = new Map();
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (!Array.isArray(r) || typeof r[0] !== "string") continue;
    const [lat, lon, src] = [r[4], r[5], r[6]];
    if (typeof lat === "number" && typeof lon === "number" && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (src === "w" || src === "c")) {
      out.set(r[0], { lat, lon, src });
    }
  }
  return out;
}
