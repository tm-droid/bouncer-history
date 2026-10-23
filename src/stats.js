/**
 * Records built across every match: per side, per pair of sides, per ground, per player.
 *
 * Fed one compact match at a time (`addMatch`), so the archive is never held whole. Super overs
 * are left out of every figure: they decide a tie, and counting them would put a six-ball innings
 * into a batting average.
 */

import { venueKey } from "./names.js";
import { aliasesFor } from "./register.js";
import { pairKey, slug, teamKey } from "./keys.js";

/**
 * The format a record is kept under. Cricsheet writes "T20" for both T20 internationals and
 * domestic T20 leagues, which a record must not mix.
 */
export function formatKey(match) {
  if (match.f === "T20" && match.tt === "international") return "T20I";
  return match.f ?? "?";
}

/** Result codes, one letter, from one side's point of view. */
export function resultFor(match, side) {
  const { w, r } = match.o;
  if (w >= 0) return w === side ? "W" : "L";
  if (r === "tie") return "T";
  if (r === "draw") return "D";
  return "N";
}

/** Cricsheet's people-register id: eight hex digits. */
export const REGISTRY_ID = /^[0-9a-f]{8}$/;

const RESULT_SLOT = { W: 1, L: 2, T: 3, D: 4, N: 5 };
const newTally = () => [0, 0, 0, 0, 0, 0]; // played, W, L, T, D, N

// Record maps are keyed by strings from Cricsheet's files (match type, team, ...). A plain {} lets
// "__proto__" select Object.prototype and the tally write into it; a null-prototype object has no
// such key and JSON.stringify writes it exactly as it writes a plain one.
const dict = () => Object.create(null);

export function createStats() {
  return { teams: new Map(), pairs: new Map(), venues: new Map(), players: new Map() };
}

export function addMatch(stats, m) {
  const fk = formatKey(m);
  const year = String(m.d ?? "").slice(0, 4);

  for (const side of [0, 1]) {
    const key = teamKey(m.t[side], m.g);
    let team = stats.teams.get(key);
    if (!team) stats.teams.set(key, (team = { t: m.t[side], g: m.g, f: dict(), y: dict(), m: [] }));
    const res = resultFor(m, side);
    tally((team.f[fk] ??= newTally()), res);
    tally((team.y[year] ??= newTally()), res);
    team.m.push([m.id, m.d, fk, m.t[1 - side], res]);
  }

  const pk = pairKey(m.t[0], m.t[1], m.g);
  let pair = stats.pairs.get(pk);
  if (!pair) {
    const sides = [...m.t].sort((a, b) => slug(a).localeCompare(slug(b)));
    stats.pairs.set(pk, (pair = { t: sides, g: m.g, f: dict(), m: [] }));
  }
  // [played, side 0 won, side 1 won, tied, drawn, no result], sides in the file's own order.
  const winnerSide = m.o.w >= 0 ? pair.t.indexOf(m.t[m.o.w]) : -1;
  const pf = (pair.f[fk] ??= [0, 0, 0, 0, 0, 0]);
  pf[0] += 1;
  if (winnerSide === 0) pf[1] += 1;
  else if (winnerSide === 1) pf[2] += 1;
  else if (m.o.r === "tie") pf[3] += 1;
  else if (m.o.r === "draw") pf[4] += 1;
  else pf[5] += 1;
  pair.m.push([m.id, m.d, fk, winnerSide, m.o.r]);

  addVenue(stats, m, fk);
  addPlayers(stats, m, fk);
}

function tally(t, res) {
  t[0] += 1;
  t[RESULT_SLOT[res]] += 1;
}

function addVenue(stats, m, fk) {
  const vk = venueKey(m.ven, m.city);
  if (!vk) return;
  const key = slug(vk.replace("@", " "));
  let venue = stats.venues.get(key);
  if (!venue) stats.venues.set(key, (venue = { n: m.ven, city: m.city, f: dict(), m: [] }));
  const first = m.inn.find((i) => !i.so);
  // [matches, first-innings runs summed, first innings counted, won batting first, won chasing]
  const vf = (venue.f[fk] ??= [0, 0, 0, 0, 0]);
  vf[0] += 1;
  if (first) {
    vf[1] += first.sc.tot[0];
    vf[2] += 1;
    if (m.o.w >= 0 && fk !== "Test" && fk !== "MDM") {
      if (m.o.w === first.t) vf[3] += 1;
      else vf[4] += 1;
    }
  }
  venue.m.push([m.id, m.d, fk, m.t[0], m.t[1], m.o.w]);
}

function addPlayers(stats, m, fk) {
  // A player's side is the eleven they were named in. A substitute fielder is in no eleven.
  const sideOf = new Map();
  m.xi.forEach((xi, side) => xi.forEach((idx) => sideOf.set(idx, side)));

  const per = new Map(); // person index -> this match's line
  const lineFor = (idx) => {
    if (!per.has(idx)) per.set(idx, { r: 0, b: 0, outs: 0, inn: 0, wk: 0, rc: 0, bb: 0, ct: 0, st: 0, f4: 0, s6: 0, w4: 0, w5: 0, best: null, innings: [] });
    return per.get(idx);
  };
  for (const idx of sideOf.keys()) lineFor(idx);

  for (const inn of m.inn) {
    if (inn.so) continue;
    for (const [idx, r, b, f4, s6, how] of inn.sc.bat) {
      const line = lineFor(idx);
      line.inn += 1;
      line.r += r;
      line.b += b;
      line.f4 += f4;
      line.s6 += s6;
      const out = how !== null && how !== "retired hurt" && how !== "retired not out";
      if (out) line.outs += 1;
      line.innings.push([r, out]);
    }
    for (const [idx, balls, , runs, wk] of inn.sc.bowl) {
      const line = lineFor(idx);
      line.bb += balls;
      line.rc += runs;
      line.wk += wk;
      if (wk >= 4) line.w4 += 1;
      if (wk >= 5) line.w5 += 1;
      if (!line.best || wk > line.best[0] || (wk === line.best[0] && runs < line.best[1])) line.best = [wk, runs];
    }
    for (const d of inn.b) {
      for (const [kind, , ...fielders] of d[8] ?? []) {
        if (kind === "caught" && fielders[0] >= 0) lineFor(fielders[0]).ct += 1;
        else if (kind === "caught and bowled") lineFor(d[3]).ct += 1;
        else if (kind === "stumped" && fielders[0] >= 0) lineFor(fielders[0]).st += 1;
      }
    }
  }

  for (const [idx, line] of per) {
    const person = m.p[idx];
    const id = person?.[1];
    // No registry id: the name alone cannot be joined across matches. The id also becomes a file
    // name, and it comes from a third party's file, so anything but Cricsheet's 8-hex form is
    // dropped rather than allowed to pick a path ("../../x").
    if (!id || !REGISTRY_ID.test(id)) continue;
    const side = sideOf.get(idx);
    if (side === undefined) continue;
    let player = stats.players.get(id);
    if (!player) stats.players.set(id, (player = { n: person[0], f: dict(), tm: dict(), m: [] }));
    player.tm[m.t[side]] = (player.tm[m.t[side]] ?? 0) + 1;
    // [matches, innings, not outs, runs, balls faced, high score, high score not out, 50s, 100s,
    //  balls bowled, runs conceded, wickets, best wickets, best runs, catches, stumpings,
    //  fours, sixes, innings of 4+ wickets, innings of 5+ wickets]
    // best runs is -1 until the player has bowled. Appended after the first 16 so older readers
    // that take the first 16 are unaffected.
    const a = (player.f[fk] ??= [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -1, 0, 0, 0, 0, 0, 0]);
    a[0] += 1;
    for (const [r, out] of line.innings) {
      a[1] += 1;
      if (!out) a[2] += 1;
      a[3] += r;
      if (r > a[5] || (r === a[5] && !out)) {
        a[5] = r;
        a[6] = out ? 0 : 1;
      }
      if (r >= 100) a[8] += 1;
      else if (r >= 50) a[7] += 1;
    }
    a[4] += line.b;
    a[9] += line.bb;
    a[10] += line.rc;
    a[11] += line.wk;
    if (line.best && (a[13] < 0 || line.best[0] > a[12] || (line.best[0] === a[12] && line.best[1] < a[13]))) {
      a[12] = line.best[0];
      a[13] = line.best[1];
    }
    a[14] += line.ct;
    a[15] += line.st;
    a[16] += line.f4;
    a[17] += line.s6;
    a[18] += line.w4;
    a[19] += line.w5;
    // [match, date, format, side, opponent, runs, balls, dismissals, wickets, runs conceded]
    player.m.push([m.id, m.d, fk, m.t[side], m.t[1 - side], line.r, line.b, line.outs, line.wk, line.rc]);
  }
}

const byDateDesc = (a, b) => String(b[1]).localeCompare(String(a[1])) || String(b[0]).localeCompare(String(a[0]));

/**
 * `[key, name, city, matches]` for every ground, most-played first. The app looks a ground up by
 * name here because Cricbuzz's venue text is not Cricsheet's, then reads `s/venue/<key>.json`.
 */
export function venueIndex(stats) {
  return [...stats.venues]
    .map(([key, v]) => [key, v.n, v.city ?? null, v.m.length])
    .sort((a, b) => b[3] - a[3] || a[0].localeCompare(b[0]));
}

/** Every stats file, as [path, object]. Match lists newest first. Player records get the register's ids. */
export function* statsFiles(stats, register = null, bios = null) {
  for (const [key, team] of stats.teams) {
    team.m.sort(byDateDesc);
    yield [`s/team/${key}.json`, team];
  }
  for (const [key, pair] of stats.pairs) {
    pair.m.sort(byDateDesc);
    yield [`s/h2h/${key}.json`, pair];
  }
  for (const [key, venue] of stats.venues) {
    venue.m.sort(byDateDesc);
    yield [`s/venue/${key}.json`, venue];
  }
  for (const [id, player] of stats.players) {
    player.m.sort(byDateDesc);
    // Appended after `m`; the register's Cricbuzz and Cricinfo ids, where it has them.
    const known = register?.ids.get(id);
    if (known?.cb) player.cb = known.cb;
    if (known?.ci) player.ci = known.ci;
    const bio = bios?.get(id);
    if (bio) player.bio = bio;
    yield [`s/p/${id}.json`, player];
  }
}

/**
 * Name lookup, one file per surname initial: `[name, registry id, main side, matches, cricbuzz id?]`.
 * The fifth cell is present only when the register knows the Cricbuzz id. A player's other names
 * (`aliases`, from the register) are further rows with the same id, filed under the alias's own
 * surname initial, so an old reader that takes four cells sees them as one more player.
 */
export function playerNameFiles(stats, register = null) {
  const byLetter = new Map();
  const add = (name, id, side, matches, cb) => {
    const surname = name.trim().split(/\s+/).pop() ?? "";
    const letter = /^[a-z]$/i.test(surname[0] ?? "") ? surname[0].toLowerCase() : "0";
    if (!byLetter.has(letter)) byLetter.set(letter, []);
    byLetter.get(letter).push(cb ? [name, id, side, matches, cb] : [name, id, side, matches]);
  };
  for (const [id, player] of stats.players) {
    const side = Object.entries(player.tm).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const cb = register?.ids.get(id)?.cb;
    add(player.n, id, side, player.m.length, cb);
    for (const alias of aliasesFor(player.n, register?.names.get(id))) add(alias, id, side, player.m.length, cb);
  }
  return [...byLetter].map(([letter, rows]) => [`s/p/names/${letter}.json`, rows.sort((a, b) => b[3] - a[3])]);
}
