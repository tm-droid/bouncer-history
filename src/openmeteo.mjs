/**
 * Open-Meteo plumbing shared by the history builder and `appwrite/tools/weather-backfill.mjs`:
 * the city geocoder's candidate choice and a polite JSON fetcher. Open-Meteo data is CC BY 4.0;
 * the app credits it wherever it shows weather.
 */

export const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
export const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";

/** A country as Open-Meteo names it, for a side as Cricsheet names it. */
export const TEAM_COUNTRY = {
  England: "United Kingdom", Scotland: "United Kingdom", Wales: "United Kingdom",
  "United Arab Emirates": "United Arab Emirates", "United States of America": "United States",
  "Hong Kong": "Hong Kong", "Papua New Guinea": "Papua New Guinea",
};
export const WEST_INDIES = new Set(["Barbados", "Jamaica", "Trinidad and Tobago", "Guyana", "Antigua and Barbuda", "Saint Lucia", "Grenada", "Saint Kitts and Nevis", "Saint Vincent and the Grenadines", "Dominica"]);
export const CRICKET_COUNTRIES = ["India", "Australia", "United Kingdom", "South Africa", "New Zealand", "Pakistan", "Sri Lanka", "Bangladesh", "Zimbabwe", "Ireland", "United Arab Emirates", "Afghanistan", "Netherlands", "Nepal", "Oman", "Namibia", "Kenya", "Uganda", "Malaysia", "Singapore", "Hong Kong", "Canada", "United States"];

/**
 * A city name alone is ambiguous ("Hamilton" is Ontario before it is Waikato); the sides that
 * have played there are the only hint the archive carries. `teamCounts` is Map(team -> matches).
 */
export function chooseCandidate(results, teamCounts) {
  if (!results?.length) return null;
  let best = null;
  let bestScore = -1;
  for (const r of results) {
    let score = 0;
    for (const [team, n] of teamCounts) {
      const country = TEAM_COUNTRY[team] ?? team;
      if (country === r.country || (team === "West Indies" && WEST_INDIES.has(r.country))) score += n * 1000;
    }
    const rank = CRICKET_COUNTRIES.indexOf(r.country);
    if (WEST_INDIES.has(r.country)) score += 50;
    else if (rank >= 0) score += 100 - rank;
    score += Math.min((r.population ?? 0) / 1e7, 1);
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

/** Thrown on HTTP 429: the allowance is spent, so every further call this run would fail too. */
export class RateLimited extends Error {}

/**
 * A JSON fetcher that spaces calls `gapMs` apart, retries dropped connections and 5xx, and counts
 * every call in `.calls`. `fetchImpl` and `sleep` are injectable for tests.
 */
export function makeFetcher({ gapMs = 700, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const getJson = async (url) => {
    getJson.calls++;
    await sleep(gapMs);
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
      } catch (e) {
        if (attempt >= 4) throw new Error(`${e?.message ?? e} (${attempt} attempts)`);
        await sleep(2000 * attempt);
        continue;
      }
      if (res.ok) return res.json();
      if (res.status === 429) throw new RateLimited("HTTP 429");
      if (attempt >= 4 || res.status < 500) throw new Error(`HTTP ${res.status}`);
      await sleep(2000 * attempt);
    }
  };
  getJson.calls = 0;
  return getJson;
}

/** Great-circle distance in km. */
export function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
