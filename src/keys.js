/**
 * File keys for the published history. They are paths on GitHub Pages, so they must be stable
 * across builds (a device caches them) and safe as file names.
 */

import { squash } from "./names.js";

/** "Sri Lanka" -> "sri-lanka". Never contains "__", which separates key parts. */
export function slug(text) {
  return squash(text).replace(/ /g, "-") || "unknown";
}

/** Cricsheet names a women's side the same as the men's ("India"), with `gender` apart. */
export function teamKey(team, gender) {
  return gender === "female" ? `${slug(team)}__w` : slug(team);
}

/** One file per pair of sides, whichever order they played in. */
export function pairKey(teamA, teamB, gender) {
  const [a, b] = [slug(teamA), slug(teamB)].sort();
  return gender === "female" ? `${a}__${b}__w` : `${a}__${b}`;
}

/** "2011-04-02" -> "2011-04", the month index a match is listed in. */
export function monthOf(date) {
  return String(date).slice(0, 7);
}
