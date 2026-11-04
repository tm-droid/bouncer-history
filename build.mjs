#!/usr/bin/env node
//
// Build the historical-match site from Cricsheet's archive.
//
// USAGE
//   node build.mjs <all_json.zip> <out dir>
//
// Writes the files GitHub Pages serves from `tm-droid/bouncer-history` (see
// `.claude/rules/history-data.md`): one compact file per match, month and search indexes, and
// records per side, pair of sides, ground and player. The out dir is emptied first.
//
// Cricsheet is ODC-BY: re-hosting is allowed with attribution, which the app shows. Nothing from
// Cricbuzz may go into this output: the site is public.
//
// Exits non-zero when the output passes SIZE_LIMIT_BYTES. GitHub Pages refuses a site over 1 GB,
// and finding that out from a failed deploy would leave the published copy stale with no error.

import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { compactMatch, SCHEMA_VERSION } from "./src/match.js";
import { addMatch, createStats, formatKey, playerNameFiles, statsFiles, venueIndex } from "./src/stats.js";
import { parseRegister } from "./src/register.js";
import { biosByRegId, loadWikidata } from "./src/wikidata.mjs";
import { monthOf, slug, teamKey } from "./src/keys.js";
import { venueKey } from "./src/names.js";
import { endDate, fillWeather, loadPublished, mergeWeather, validWeather } from "./src/weather.mjs";
import { coordsFromRows, geocodeCity, loadGrounds, resolveVenues } from "./src/venuecoords.mjs";
import { makeFetcher } from "./src/openmeteo.mjs";

export const SIZE_LIMIT_BYTES = 900 * 1024 * 1024;

// Optional: --weather-cache <dir> (local cache, filled between runs), --weather-limit <calls>
// (default WEATHER_LIMIT or 4500), --no-weather.
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args.splice(i, 2)[1] ?? null;
};
const weatherCacheDir = option("--weather-cache");
const weatherLimit = Number(option("--weather-limit") ?? process.env.WEATHER_LIMIT ?? 4500);
const noWeather = args.includes("--no-weather");
const [zipPath, outDir] = args.filter((a) => a !== "--no-weather");
if (!zipPath || !outDir) {
  console.error("usage: node build.mjs <all_json.zip> <out dir> [--weather-cache dir] [--weather-limit n] [--no-weather]");
  process.exit(1);
}
const SITE_URL = "https://tm-droid.github.io/bouncer-history/";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const mb = (n) => (n / 1024 / 1024).toFixed(1);
let bytes = 0;
let files = 0;
const root = path.resolve(outDir);
const write = (rel, obj) => {
  const file = path.resolve(root, rel);
  // Every path is built from keys the builder slugs or validates; this is the backstop that keeps
  // a key derived from Cricsheet's data from ever writing outside the site.
  if (!file.startsWith(root + path.sep)) throw new Error(`refusing to write outside ${root}: ${rel}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(obj);
  fs.writeFileSync(file, text);
  bytes += Buffer.byteLength(text);
  files += 1;
};

// The register sits beside the archive. A failed download builds without it (records lose their
// Cricbuzz/Cricinfo ids and aliases for a week) rather than leaving the published site stale.
const REGISTER_URL = "https://cricsheet.org/register/";
async function loadRegister() {
  const dir = path.dirname(path.resolve(zipPath));
  const read = async (name) => {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      const res = await fetch(REGISTER_URL + name, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    }
    return fs.readFileSync(file, "utf8");
  };
  try {
    return parseRegister(await read("people.csv"), await read("names.csv"));
  } catch (e) {
    console.error(`register unavailable, building without it: ${e?.message}`);
    return null;
  }
}
const register = await loadRegister();

// Bios (birth date, birthplace, photo credit, Wikipedia) from Wikidata and Commons, joined on the
// register's Cricinfo id. Cached beside the archive for under a week; a failure builds without.
const bios = register
  ? biosByRegId(
      register,
      await loadWikidata({
        cacheDir: path.dirname(path.resolve(zipPath)),
        wanted: new Set([...register.ids.values()].map((v) => v.ci).filter(Boolean)),
      })
    )
  : new Map();

let zip = new AdmZip(zipPath);
const entries = zip.getEntries().filter((e) => !e.isDirectory && /^\d+\.json$/.test(path.basename(e.entryName)));

// Weather and ground coordinates. Everything here is best effort: any failure builds the site
// without weather for the matches it touches, never fails the build.
const weatherById = new Map();
const venueCoords = new Map();
async function loadWeather() {
  // Pass one reads only where and when each match was played.
  const matches = [];
  const grounds = new Map();
  for (const entry of entries) {
    try {
      const info = JSON.parse(entry.getData().toString("utf8")).info ?? {};
      const d = info.dates?.[0];
      if ((info.teams ?? []).length !== 2 || !DATE_RE.test(d ?? "")) continue;
      const vk = venueKey(info.venue, info.city);
      if (!vk) continue;
      const key = slug(vk.replace("@", " "));
      const id = path.basename(entry.entryName, ".json");
      matches.push({ id, key, start: d, end: endDate(d, info.dates.length) });
      const g = grounds.get(key) ?? grounds.set(key, { key, name: info.venue, city: info.city ?? null, teams: new Map() }).get(key);
      for (const t of info.teams) g.teams.set(t, (g.teams.get(t) ?? 0) + 1);
    } catch {
      // Unreadable here means skipped by the main pass as well.
    }
  }
  const cacheFile = weatherCacheDir ? path.join(weatherCacheDir, "weather-cache.json") : null;
  const local = { w: {}, v: [] };
  try {
    if (cacheFile && fs.existsSync(cacheFile)) Object.assign(local, JSON.parse(fs.readFileSync(cacheFile, "utf8")));
  } catch {
    // A corrupt local cache is an empty one.
  }
  const published = await loadPublished({ baseUrl: SITE_URL });
  const have = mergeWeather(
    published.weather,
    new Map(Object.entries(local.w ?? {}).filter(([, w]) => validWeather(w)))
  );
  const previous = new Map([...coordsFromRows(published.venueRows), ...coordsFromRows(local.v)]);
  console.log(`weather cache: ${have.size} matches, ${previous.size} grounds with coordinates`);

  const getJson = makeFetcher({ gapMs: 700 });
  const resolved = await resolveVenues({
    venues: [...grounds.values()],
    previous,
    grounds: await loadGrounds({ cacheDir: weatherCacheDir }),
    geocode: (place, teams) => geocodeCity(getJson, place, teams),
  });
  for (const [k, v] of resolved) venueCoords.set(k, v);
  const bySrc = { w: 0, c: 0 };
  for (const v of resolved.values()) bySrc[v.src]++;
  console.log(`ground coordinates: ${resolved.size}/${grounds.size} (Wikidata ${bySrc.w}, city geocode ${bySrc.c}), ${getJson.calls} geocode calls`);

  const ids = new Set(matches.map((m) => m.id));
  for (const [id, w] of have) if (ids.has(id)) weatherById.set(id, w);
  const coordPairs = new Map([...resolved].map(([k, v]) => [k, [v.lat, v.lon]]));
  const fetcher = makeFetcher({ gapMs: 700 });
  const run = await fillWeather({ matches, have: weatherById, coords: coordPairs, getJson: fetcher, cap: weatherLimit, log: console.log });
  for (const [id, w] of run.weather) weatherById.set(id, w);
  console.log(`weather: ${run.fetched} fetched in ${run.calls} calls${run.stopped ? ` (stopped: ${run.stopped})` : ""}; ${weatherById.size}/${matches.length} matches have it`);
  if (cacheFile) {
    fs.mkdirSync(weatherCacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ w: Object.fromEntries(weatherById), v: [...venueCoords].map(([k, v]) => [k, "", "", 0, v.lat, v.lon, v.src]) }));
  }
}
if (!noWeather) {
  try {
    await loadWeather();
  } catch (e) {
    console.error(`weather skipped: ${e?.message}`);
  }
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const stats = createStats();
const months = new Map();
const teams = new Map();
let parsed = 0;
const parsedIds = [];
let skipped = 0;
let badDate = 0;

// Each entry slot is cleared once read: adm-zip keeps an entry's inflated bytes for as long as
// the entry is referenced (the trainer died at 512 MB on exactly this, build.js).
for (let i = 0; i < entries.length; i++) {
  const entry = entries[i];
  entries[i] = null;
  const id = path.basename(entry.entryName, ".json");
  let match;
  try {
    match = compactMatch(id, JSON.parse(entry.getData().toString("utf8")));
  } catch (e) {
    if (skipped < 5) console.error(`skipped ${entry.entryName}: ${e?.message}`);
    skipped++;
    continue;
  }
  if (!match || !match.d) {
    skipped++;
    continue;
  }
  // The date becomes the `idx/m/<month>.json` file name, so only a plain YYYY-MM-DD gets through.
  if (!DATE_RE.test(match.d)) {
    badDate++;
    skipped++;
    continue;
  }
  parsed++;
  parsedIds.push(id);
  const weather = weatherById.get(id);
  if (weather) match.w = weather;
  write(`m/${id}.json`, match);
  addMatch(stats, match);

  const fk = formatKey(match);
  const row = [match.id, match.d, fk, match.g, match.t[0], match.t[1], match.o.w, match.o.r, match.e?.n ?? null, match.ven];
  const month = monthOf(match.d);
  if (!MONTH_RE.test(month)) throw new Error(`bad month ${month}`);
  if (!months.has(month)) months.set(month, []);
  months.get(month).push(row);
  for (const team of match.t) {
    const key = teamKey(team, match.g);
    const t = teams.get(key) ?? { n: team, g: match.g, c: 0 };
    t.c += 1;
    teams.set(key, t);
  }
}
entries.length = 0;
zip = null;
if (badDate) console.error(`skipped ${badDate} matches whose date is not YYYY-MM-DD`);
console.log(`parsed ${parsed}, skipped ${skipped}, RSS ${mb(process.memoryUsage().rss)} MB`);

const byDate = (a, b) => String(a[1]).localeCompare(String(b[1])) || String(a[0]).localeCompare(String(b[0]));
const years = {};
const search = [];
for (const [month, rows] of [...months].sort()) {
  rows.sort(byDate);
  write(`idx/m/${month}.json`, rows);
  const [y, mo] = month.split("-");
  (years[y] ??= {})[mo] = rows.length;
  // The search index drops the ground: it is ~10% of the bytes and nobody searches by it.
  for (const r of rows) search.push(r.slice(0, 9));
}
write("idx/years.json", years);
write("idx/search.json", search);
write(
  "idx/teams.json",
  [...teams].map(([key, t]) => [t.n, t.g, key, t.c]).sort((a, b) => b[3] - a[3])
);

for (const [rel, obj] of statsFiles(stats, register, bios)) write(rel, obj);
write(
  "idx/venues.json",
  venueIndex(stats).map((row) => {
    const at = venueCoords.get(row[0]);
    return at ? [...row, at.lat, at.lon, at.src] : row;
  })
);
if (weatherById.size) {
  const shown = new Set(parsedIds);
  write("idx/weather.json", Object.fromEntries([...weatherById].filter(([id]) => shown.has(id))));
}
for (const [rel, obj] of playerNameFiles(stats, register)) write(rel, obj);

// Last, so a reader that sees this build's manifest sees every file it describes.
const manifest = { v: SCHEMA_VERSION, built: new Date().toISOString(), matches: parsed, files: files + 1, bytes };
write("manifest.json", manifest);
// Pages would run Jekyll over the tree otherwise, and Jekyll skips nothing we need but costs a
// build minute per deploy.
fs.writeFileSync(path.join(outDir, ".nojekyll"), "");
fs.writeFileSync(
  path.join(outDir, "README.md"),
  [
    "# Bouncer history",
    "",
    "Match data for the Bouncer cricket app, rebuilt weekly. Not hand-edited: every push replaces the branch.",
    "",
    "Ball-by-ball data from [Cricsheet](https://cricsheet.org/), made available under the",
    "[Open Data Commons Attribution License (ODC-BY 1.0)](https://opendatacommons.org/licenses/by/1-0/).",
    "",
    `Built ${manifest.built} from ${parsed} matches.`,
    "",
    "Weather: [Open-Meteo.com](https://open-meteo.com/) historical archive, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).",
    "Ground coordinates: [Wikidata](https://www.wikidata.org/) (CC0) and Open-Meteo geocoding.",
    "",
  ].join("\n")
);

console.log(`wrote ${files} files, ${mb(bytes)} MB, RSS ${mb(process.memoryUsage().rss)} MB`);
if (bytes > SIZE_LIMIT_BYTES) {
  console.error(`output ${mb(bytes)} MB is over the ${mb(SIZE_LIMIT_BYTES)} MB limit (GitHub Pages refuses 1 GB)`);
  process.exit(1);
}
