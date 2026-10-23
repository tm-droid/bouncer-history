import test from "node:test";
import assert from "node:assert/strict";
import { DAILY, daysBetween, endDate, fillWeather, loadPublished, mergeWeather, weatherOf, windowsOf } from "../src/weather.mjs";
import { RateLimited, makeFetcher } from "../src/openmeteo.mjs";
import { coordsFromRows, groundsByName, resolveVenues } from "../src/venuecoords.mjs";

const daily = {
  time: ["2024-01-01", "2024-01-02", "2024-01-03"],
  temperature_2m_max: [30.04, 33.26, 28],
  precipitation_sum: [0, 1.25, 0.5],
  relative_humidity_2m_mean: [60, 70, 80],
  wind_speed_10m_max: [10.4, 25.6, 12],
  cloud_cover_mean: [10, 20, 90],
};

test("DAILY names the five variables the mapping reads", () => {
  assert.deepEqual(DAILY.split(","), ["temperature_2m_max", "precipitation_sum", "relative_humidity_2m_mean", "wind_speed_10m_max", "cloud_cover_mean"]);
});

test("weatherOf: max temp, summed rain, mean humidity, max wind, mean cloud", () => {
  assert.deepEqual(weatherOf(daily, ["2024-01-01"]), [30, 0, 60, 10, 10]);
  assert.deepEqual(weatherOf(daily, daysBetween("2024-01-01", "2024-01-03")), [33.3, 1.8, 70, 26, 40]);
});

test("weatherOf: days outside the answer and nulls are ignored; a missing variable gives null", () => {
  assert.deepEqual(weatherOf(daily, ["2024-01-02", "2030-01-01"]), [33.3, 1.3, 70, 26, 20]);
  assert.equal(weatherOf(daily, ["2030-01-01"]), null);
  assert.equal(weatherOf({ ...daily, precipitation_sum: [null, null, null] }, ["2024-01-01"]), null);
  assert.equal(weatherOf(null, ["2024-01-01"]), null);
});

test("a five-day Test spans five dates, and a month boundary is crossed", () => {
  assert.equal(endDate("2024-01-30", 5), "2024-02-03");
  assert.equal(endDate("2024-01-30", 1), "2024-01-30");
  assert.deepEqual(daysBetween("2024-02-28", "2024-03-01"), ["2024-02-28", "2024-02-29", "2024-03-01"]);
});

const m = (id, key, start, ds = 1) => ({ id, key, start, end: endDate(start, ds) });

test("windowsOf: one ground within 14 days is one request, newest first", () => {
  const w = windowsOf([m("1", "a", "2024-01-01"), m("2", "a", "2024-01-10"), m("3", "a", "2024-03-01"), m("4", "b", "2024-01-05")]);
  assert.equal(w.length, 3);
  assert.deepEqual(w[0].matches.map((x) => x.id), ["3"]);
  assert.deepEqual(w.find((x) => x.key === "a" && x.start === "2024-01-01").matches.map((x) => x.id), ["1", "2"]);
});

const TODAY = "2025-06-30";
const answer = (url) => {
  const [, lat, lon, start, end] = /latitude=([^&]+)&longitude=([^&]+)&start_date=([^&]+)&end_date=([^&]+)/.exec(url);
  const time = daysBetween(start, end);
  return { daily: { time, temperature_2m_max: time.map(() => 20), precipitation_sum: time.map(() => 1), relative_humidity_2m_mean: time.map(() => 50), wind_speed_10m_max: time.map(() => 9), cloud_cover_mean: time.map(() => 30) } };
};

test("fillWeather asks only for matches the cache lacks and skips matches without coordinates or too recent for the archive", async () => {
  const urls = [];
  const getJson = async (u) => (urls.push(u), answer(u));
  const matches = [m("1", "a", "2024-01-01"), m("2", "a", "2024-01-02"), m("3", "nocoords", "2024-01-01"), m("4", "a", "2025-06-29"), m("5", "a", "2023-05-05")];
  const have = new Map([["5", [1, 2, 3, 4, 5]]]);
  const r = await fillWeather({ matches, have, coords: new Map([["a", [1, 2]]]), getJson, cap: 100, today: TODAY });
  assert.equal(urls.length, 1);
  assert.deepEqual([...r.weather.keys()].sort(), ["1", "2"]);
  assert.deepEqual(r.weather.get("1"), [20, 1, 50, 9, 30]);
  assert.equal(r.stopped, null);
});

test("fillWeather never exceeds its call cap", async () => {
  let n = 0;
  const getJson = async (u) => (n++, answer(u));
  const matches = Array.from({ length: 50 }, (_, i) => m(String(i), `g${i}`, "2024-01-01"));
  const coords = new Map(matches.map((x) => [x.key, [0, 0]]));
  const r = await fillWeather({ matches, have: new Map(), coords, getJson, cap: 7, today: TODAY });
  assert.equal(n, 7);
  assert.equal(r.calls, 7);
  assert.equal(r.weather.size, 7);
  assert.equal(r.stopped, "cap");
});

test("fillWeather tolerates failures: a rate limit stops with what it has, errors skip a window", async () => {
  const matches = Array.from({ length: 6 }, (_, i) => m(String(i), `g${i}`, `2024-01-0${i + 1}`));
  const coords = new Map(matches.map((x) => [x.key, [0, 0]]));
  let n = 0;
  const limited = async (u) => {
    if (++n === 3) throw new RateLimited("429");
    return answer(u);
  };
  const a = await fillWeather({ matches, have: new Map(), coords, getJson: limited, cap: 100, today: TODAY });
  assert.equal(a.weather.size, 2);
  assert.equal(a.stopped, "rate limited");

  n = 0;
  const flaky = async (u) => {
    if (++n === 2) throw new Error("boom");
    return answer(u);
  };
  const b = await fillWeather({ matches, have: new Map(), coords, getJson: flaky, cap: 100, today: TODAY });
  assert.equal(b.weather.size, 5);
  assert.equal(b.stopped, null);

  const dead = async () => {
    throw new Error("offline");
  };
  const c = await fillWeather({ matches, have: new Map(), coords, getJson: dead, cap: 100, today: TODAY });
  assert.equal(c.weather.size, 0);
  assert.match(c.stopped, /errors/);

  const empty = async () => ({});
  assert.equal((await fillWeather({ matches, have: new Map(), coords, getJson: empty, cap: 100, today: TODAY })).weather.size, 0);
});

test("self-cache: published weather loads, bad cells are dropped, a failed fetch is an empty cache", async () => {
  const site = {
    "https://x/idx/weather.json": { 1: [30, 0, 60, 10, 10], 2: [1, 2], 3: "no", 4: [1, 2, 3, 4, NaN] },
    "https://x/idx/venues.json": [["k", "n", "c", 1, 10.5, 20.5, "w"]],
  };
  const fetchImpl = async (u) => (u in site ? { ok: true, json: async () => site[u] } : { ok: false, status: 404 });
  const p = await loadPublished({ baseUrl: "https://x/", fetchImpl });
  assert.deepEqual([...p.weather.keys()], ["1"]);
  assert.deepEqual(coordsFromRows(p.venueRows).get("k"), { lat: 10.5, lon: 20.5, src: "w" });

  const down = await loadPublished({ baseUrl: "https://x/", fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(down.weather.size, 0);
  assert.equal(coordsFromRows(down.venueRows).size, 0);
});

test("mergeWeather: union, later cache wins", () => {
  const out = mergeWeather(new Map([["1", [1]], ["2", [2]]]), new Map([["2", [9]], ["3", [3]]]));
  assert.deepEqual([...out], [["1", [1]], ["2", [9]], ["3", [3]]]);
});

test("coordsFromRows tolerates old 4-cell rows and junk", () => {
  const out = coordsFromRows([["a", "A", null, 3], ["b", "B", "C", 1, 1.5, 2.5, "c"], ["c", "C", "C", 1, 200, 2, "c"], "x", null]);
  assert.deepEqual([...out.keys()], ["b"]);
});

test("makeFetcher retries 5xx, counts calls, and raises RateLimited on 429", async () => {
  const replies = [{ ok: false, status: 503 }, { ok: true, json: async () => ({ ok: 1 }) }];
  const f = makeFetcher({ gapMs: 0, sleep: async () => {}, fetchImpl: async () => replies.shift() });
  assert.deepEqual(await f("u"), { ok: 1 });
  const g = makeFetcher({ gapMs: 0, sleep: async () => {}, fetchImpl: async () => ({ ok: false, status: 429 }) });
  await assert.rejects(() => g("u"), RateLimited);
});

const wd = (id, label, lat, lon) => ({ i: { value: id }, l: { value: label }, c: { value: `Point(${lon} ${lat})` } });

test("resolveVenues: Wikidata when it agrees with the city, else the city; ambiguous names fall back", async () => {
  const grounds = groundsByName({
    results: {
      bindings: [
        wd("Q1", "Wankhede Stadium", 18.938, 72.826),
        wd("Q2", "County Ground", 51.5, -0.1),
        wd("Q3", "County Ground", 52.9, -1.2),
        wd("Q4", "Victoria Park", -33.9, 151.2), // same name, wrong continent for the city below
      ],
    },
  });
  const points = { Mumbai: [19.07, 72.88], Bristol: [51.45, -2.59], Colombo: [6.93, 79.85], Nowhere: null };
  const geocode = async (place) => points[place] ?? null;
  const venues = [
    { key: "wankhede", name: "Wankhede Stadium, Mumbai", city: "Mumbai", teams: new Map() },
    { key: "county-bristol", name: "County Ground", city: "Bristol", teams: new Map() },
    { key: "county-none", name: "County Ground", city: "Nowhere", teams: new Map() },
    { key: "vp", name: "Victoria Park", city: "Colombo", teams: new Map() },
    { key: "unknown", name: "Mystery Oval", city: "Nowhere", teams: new Map() },
  ];
  const out = await resolveVenues({ venues, grounds, geocode });
  assert.deepEqual(out.get("wankhede"), { lat: 18.938, lon: 72.826, src: "w" });
  assert.equal(out.get("county-bristol").src, "c"); // neither County Ground is within 100 km of Bristol
  assert.equal(out.has("county-none"), false); // two candidates and no city point to choose by
  assert.deepEqual(out.get("vp"), { lat: 6.93, lon: 79.85, src: "c" });
  assert.equal(out.has("unknown"), false);
});

test("resolveVenues keeps last week's Wikidata point, reuses a city point, and survives a failed Wikidata query", async () => {
  let asked = 0;
  const geocode = async () => (asked++, [1, 1]);
  const venues = [
    { key: "a", name: "A", city: "X", teams: new Map() },
    { key: "b", name: "B", city: "Y", teams: new Map() },
  ];
  const previous = new Map([["a", { lat: 5, lon: 5, src: "w" }], ["b", { lat: 2, lon: 2, src: "c" }]]);
  const out = await resolveVenues({ venues, previous, grounds: null, geocode });
  assert.equal(asked, 0);
  assert.deepEqual(out.get("a"), { lat: 5, lon: 5, src: "w" });
  assert.deepEqual(out.get("b"), { lat: 2, lon: 2, src: "c" });
});
