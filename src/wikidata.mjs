/**
 * Player bios from Wikidata (CC0) and Wikimedia Commons, joined on the Cricinfo id Cricsheet's
 * register gives a player (Wikidata P2697, "ESPNcricinfo player ID"). Nothing is copied but text:
 * the photo is stored as a thumbnail URL plus the author and licence Commons records for it, so
 * the app can hotlink it with credit. Cricbuzz and Cricinfo content is never read; only the id.
 *
 * Properties: P2697 id, P569 date of birth (with precision), P19 place of birth, P18 image,
 * English Wikipedia sitelink. Batting/bowling style is skipped: Wikidata has a bowling style
 * (P2545) on about 1,100 of 31,700 cricketers and no batting-hand property, too sparse to show.
 *
 * Every value here is a third party's text that ends up in published files, so it is bounded and
 * stripped of markup. A failed query never fails the build; the caller gets null.
 */

import fs from "node:fs";

export const USER_AGENT = "BouncerHistoryBuilder/1.0 (https://github.com/tm-droid/bouncer-history; malhotra.tanush@gmail.com)";
const SPARQL_URL = "https://query.wikidata.org/sparql";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
export const CACHE_FILE = "wikidata-cache.json";
/** Under a week, so the weekly build always refreshes, and a rerun the same day does not. */
export const CACHE_MAX_AGE_MS = 6 * 24 * 3600 * 1000;
const BATCH = 50;
const THUMB_WIDTH = 330; // one of Wikimedia's standard thumbnail steps
const MAX_ARTIST = 80;
const MAX_PLACE = 80;

const PRECISION_FORMAT = { 11: 10, 10: 7, 9: 4 }; // Wikidata precision to the length of "YYYY-MM-DD" kept

const QUERIES = {
  dob: "SELECT ?id ?v ?p ?r WHERE { ?i wdt:P2697 ?id. ?i p:P569 ?s. ?s psv:P569 ?n; wikibase:rank ?r. ?n wikibase:timeValue ?v; wikibase:timePrecision ?p. FILTER(?r != wikibase:DeprecatedRank) }",
  place: "SELECT ?id ?v WHERE { ?i wdt:P2697 ?id; wdt:P19 ?v }",
  image: "SELECT ?id ?v WHERE { ?i wdt:P2697 ?id; wdt:P18 ?v }",
  article:
    'SELECT ?id ?v WHERE { ?i wdt:P2697 ?id. ?v schema:about ?i. ?v schema:inLanguage "en"; schema:isPartOf <https://en.wikipedia.org/> }',
};

const PREFERRED = "http://wikiba.se/ontology#PreferredRank";

/** SPARQL JSON bindings to plain `{id, v, ...}` rows of strings. */
export function rows(json) {
  const out = [];
  for (const b of json?.results?.bindings ?? []) {
    const row = {};
    for (const [k, cell] of Object.entries(b)) row[k] = String(cell?.value ?? "");
    if (row.id) out.push(row);
  }
  return out;
}

/** Date of birth as `YYYY-MM-DD`, `YYYY-MM` or `YYYY` by the precision Wikidata knows; a preferred value wins, then the first. */
export function dobById(dobRows) {
  const best = new Map();
  for (const r of dobRows) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T/.exec(r.v ?? "");
    const keep = PRECISION_FORMAT[Number(r.p)];
    if (!m || !keep || m[1] < "1000") continue;
    const text = `${m[1]}-${m[2]}-${m[3]}`.slice(0, keep);
    const rank = r.r === PREFERRED ? 1 : 0;
    const cur = best.get(r.id);
    if (!cur || rank > cur.rank) best.set(r.id, { text, rank });
  }
  return new Map([...best].map(([id, v]) => [id, v.text]));
}

/** First value per Cricinfo id (the truthy `wdt:` statements already prefer the preferred rank). */
export function firstById(rowList, key = "v") {
  const out = new Map();
  for (const r of rowList) if (r[key] && !out.has(r.id)) out.set(r.id, r[key]);
  return out;
}

/** `http://commons.wikimedia.org/wiki/Special:FilePath/Name%20x.jpg` to `File:Name x.jpg`. */
export function commonsTitle(url) {
  const m = /\/Special:FilePath\/([^?#]+)$/.exec(url ?? "");
  if (!m) return null;
  try {
    const name = decodeURIComponent(m[1]).replace(/_/g, " ");
    return name && !name.includes("|") ? `File:${name}` : null;
  } catch {
    return null;
  }
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Commons' Artist field is HTML (links, spans, "<bdi>"): plain text, entities decoded, whitespace collapsed, bounded. */
export function stripHtml(html) {
  const text = String(html ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") {
        const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return code > 31 && code < 0x10ffff ? String.fromCodePoint(code) : " ";
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_ARTIST ? text.slice(0, MAX_ARTIST - 1).trimEnd() + "…" : text;
}

const NON_FREE = /fair use|non-?free|all rights reserved|copyrighted|no free|permission|unknown|restricted/i;

/** A licence the file may be shown under: named, and neither flagged non-free nor fair use. */
export function isFreeLicense(meta) {
  const name = String(meta?.LicenseShortName?.value ?? "").trim();
  if (!name || NON_FREE.test(name)) return false;
  if (/^true$/i.test(String(meta?.NonFree?.value ?? ""))) return false;
  if (/nonfree/i.test(String(meta?.Restrictions?.value ?? ""))) return false;
  return true;
}

function httpsOnly(url) {
  return typeof url === "string" && /^https:\/\//.test(url) ? url : null;
}

/** One Commons imageinfo response to Map(title -> photo) for the files that pass the licence filter. */
export function parseImageInfo(json) {
  const alias = new Map(); // requested title -> title the API answers under
  for (const n of json?.query?.normalized ?? []) alias.set(n.from, n.to);
  for (const r of json?.query?.redirects ?? []) alias.set(r.from, r.to);
  const byTitle = new Map();
  for (const page of Object.values(json?.query?.pages ?? {})) {
    const info = page?.imageinfo?.[0];
    const meta = info?.extmetadata;
    const thumb = httpsOnly(info?.thumburl)?.split("?")[0]; // drop the API's utm tracking parameters
    const page_ = httpsOnly(info?.descriptionurl);
    if (!info || !thumb || !page_ || !isFreeLicense(meta)) continue;
    const photo = { img: thumb, ip: page_, il: stripHtml(meta.LicenseShortName.value).slice(0, 40) };
    const artist = stripHtml(meta.Artist?.value);
    if (artist) photo.ia = artist;
    const lic = httpsOnly(meta.LicenseUrl?.value);
    if (lic) photo.ilu = lic;
    byTitle.set(page.title, photo);
  }
  return { byTitle, alias };
}

/** The photo for a requested title, following normalisation and redirects. */
export function photoFor(parsed, title) {
  let t = title;
  for (let i = 0; i < 3 && parsed.alias.has(t); i++) t = parsed.alias.get(t);
  return parsed.byTitle.get(t) ?? null;
}

/**
 * Joins Wikidata's per-id maps onto a Cricinfo id: the bio object stored on `s/p/<regId>.json`.
 * Keys: b birth date, bp birthplace, wp Wikipedia article, img/ia/il/ilu/ip photo (thumbnail,
 * author, licence name, licence URL, Commons file page). Null when there is nothing to show.
 */
export function bioFor(ci, data) {
  const bio = {};
  const b = data.dob[ci];
  if (b) bio.b = b;
  const bp = data.place[ci];
  if (bp) bio.bp = bp.slice(0, MAX_PLACE);
  const wp = httpsOnly(data.article[ci]);
  if (wp?.startsWith("https://en.wikipedia.org/wiki/")) bio.wp = wp;
  Object.assign(bio, data.photo[ci]);
  return Object.keys(bio).length ? bio : null;
}

/** `s/p/<regId>.json` bios by regId through the register's Cricinfo id. */
export function biosByRegId(register, data) {
  const out = new Map();
  if (!register || !data) return out;
  for (const [regId, ids] of register.ids) {
    const bio = ids.ci ? bioFor(ids.ci, data) : null;
    if (bio) out.set(regId, bio);
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, init, fetchImpl, retries = 2) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetchImpl(url, { ...init, headers: { "User-Agent": USER_AGENT, ...init?.headers }, signal: AbortSignal.timeout(90_000) });
      if (res.ok) return await res.json();
      last = new Error(`HTTP ${res.status}`);
      if (res.status !== 429 && res.status < 500) break;
    } catch (e) {
      last = e;
    }
    await sleep(2000 * (i + 1));
  }
  throw last;
}

const sparql = (query, fetchImpl) =>
  getJson(
    `${SPARQL_URL}?format=json&query=${encodeURIComponent(query)}`,
    { headers: { Accept: "application/sparql-results+json" } },
    fetchImpl
  );

async function placeLabels(qids, fetchImpl) {
  const labels = new Map();
  for (let i = 0; i < qids.length; i += BATCH) {
    const ids = qids.slice(i, i + BATCH);
    const json = await getJson(
      `${WIKIDATA_API}?action=wbgetentities&format=json&props=labels&languages=en&ids=${ids.join("|")}`,
      {},
      fetchImpl
    );
    for (const [q, e] of Object.entries(json.entities ?? {})) if (e?.labels?.en?.value) labels.set(q, e.labels.en.value);
    await sleep(250);
  }
  return labels;
}

async function photos(imageByCi, fetchImpl) {
  const titleOf = new Map(); // ci -> File: title
  for (const [ci, url] of imageByCi) {
    const t = commonsTitle(url);
    if (t) titleOf.set(ci, t);
  }
  const titles = [...new Set(titleOf.values())];
  const parsed = { byTitle: new Map(), alias: new Map() };
  for (let i = 0; i < titles.length; i += BATCH) {
    const batch = titles.slice(i, i + BATCH);
    const json = await getJson(
      `${COMMONS_API}?action=query&format=json&redirects=1&prop=imageinfo&iiprop=url%7Cextmetadata&iiurlwidth=${THUMB_WIDTH}&titles=${encodeURIComponent(batch.join("|"))}`,
      {},
      fetchImpl
    );
    const one = parseImageInfo(json);
    for (const [k, v] of one.byTitle) parsed.byTitle.set(k, v);
    for (const [k, v] of one.alias) parsed.alias.set(k, v);
    await sleep(250);
  }
  const out = {};
  for (const [ci, t] of titleOf) {
    const p = photoFor(parsed, t);
    if (p) out[ci] = p;
  }
  return out;
}

/**
 * Fetches (or reads the cache of) every Wikidata bio field for the Cricinfo ids in `wanted`.
 * Returns `{dob, place, article, photo}` keyed by Cricinfo id, or null when nothing is available.
 */
export async function loadWikidata({ cacheDir, wanted, fetchImpl = fetch, now = Date.now(), log = console }) {
  const file = `${cacheDir}/${CACHE_FILE}`;
  let cached = null;
  try {
    cached = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // no cache, or unreadable: fetch
  }
  if (cached?.data && now - cached.fetched < CACHE_MAX_AGE_MS) return cached.data;
  try {
    const only = (m) => Object.fromEntries([...m].filter(([id]) => wanted.has(id)));
    const run = async (name) => rows(await sparql(QUERIES[name], fetchImpl));
    const dob = dobById(await run("dob"));
    const placeQ = firstById(await run("place"));
    const article = firstById(await run("article"));
    const image = firstById(await run("image"));
    const wantedPlaceQ = new Map([...placeQ].filter(([id]) => wanted.has(id)).map(([id, u]) => [id, u.split("/").pop()]));
    const labels = await placeLabels([...new Set(wantedPlaceQ.values())], fetchImpl);
    const place = {};
    for (const [id, q] of wantedPlaceQ) if (labels.has(q)) place[id] = labels.get(q);
    const photo = await photos(new Map([...image].filter(([id]) => wanted.has(id))), fetchImpl);
    const data = { dob: only(dob), place, article: only(article), photo };
    try {
      fs.writeFileSync(file, JSON.stringify({ fetched: now, data }));
    } catch (e) {
      log.error(`could not cache Wikidata: ${e?.message}`);
    }
    return data;
  } catch (e) {
    log.error(`Wikidata unavailable, building without bios${cached?.data ? " (using stale cache)" : ""}: ${e?.message}`);
    return cached?.data ?? null;
  }
}
