// Copies of squash/venueName/venueKey from appwrite/functions/train-win-probability/src/contextmath.js.
// This tool also runs from the public repo (tm-droid/bouncer-history), where that function is not
// beside it. In the app repo test/names.test.js checks the two agree, so a key never drifts.

/** Lowercase, accents folded, punctuation dropped — how every name is compared and keyed. */
export function squash(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function venueName(venue) {
  return squash(String(venue ?? "").split(",")[0]);
}

export function venueKey(venue, city) {
  const name = venueName(venue);
  return name ? `${name}@${squash(city)}` : null;
}
