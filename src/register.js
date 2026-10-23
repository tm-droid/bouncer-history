/**
 * Cricsheet's people register (https://cricsheet.org/register/): one row per registry id with the
 * id this person has on Cricinfo and Cricbuzz where Cricsheet knows it, and a second file of other
 * names a person is known by. Both are ODC-BY like the matches.
 *
 * Everything read here is a third party's text that ends up in published files, so ids are kept
 * only in their plain numeric form and names are bounded.
 */

import { squash } from "./names.js";

/** RFC 4180 enough for these files: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') (field += '"'), i++;
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ",") (row.push(field), (field = ""));
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const NUMERIC_ID = /^\d{1,12}$/;
export const MAX_ALIASES = 3;
const MAX_NAME = 40;

/** @returns {{ids: Map<string, {cb?: string, ci?: string}>, names: Map<string, string[]>}} */
export function parseRegister(peopleCsv, namesCsv) {
  const ids = new Map();
  const [head, ...people] = parseCsv(peopleCsv);
  const col = (name) => head?.indexOf(name) ?? -1;
  const [iId, iCb, iCi] = [col("identifier"), col("key_cricbuzz"), col("key_cricinfo")];
  if (iId < 0 || iCb < 0 || iCi < 0) throw new Error("people.csv header changed: need identifier, key_cricbuzz, key_cricinfo");
  for (const r of people) {
    const entry = {};
    if (NUMERIC_ID.test(r[iCb] ?? "")) entry.cb = r[iCb];
    if (NUMERIC_ID.test(r[iCi] ?? "")) entry.ci = r[iCi];
    if (entry.cb || entry.ci) ids.set(r[iId], entry);
  }
  const names = new Map();
  const [nameHead, ...rows] = parseCsv(namesCsv);
  if (nameHead?.[0] !== "identifier" || nameHead?.[1] !== "name") throw new Error("names.csv header changed: need identifier, name");
  for (const [id, name] of rows) {
    if (!id || !name) continue;
    if (!names.has(id)) names.set(id, []);
    names.get(id).push(name);
  }
  return { ids, names };
}

/**
 * The other names worth a search row: those with a surname the primary name does not have. A
 * variant that only spells out the given names ("Virat Kohli" for "V Kohli") already matches
 * through the initials, so it would only add bytes.
 */
export function aliasesFor(primary, candidates) {
  const surname = (n) => squash(n).split(" ").pop();
  const seen = new Set([squash(primary)]);
  const out = [];
  for (const name of candidates ?? []) {
    const key = squash(name);
    if (!key || seen.has(key) || name.length > MAX_NAME || surname(name) === surname(primary)) continue;
    seen.add(key);
    out.push(name);
    if (out.length === MAX_ALIASES) break;
  }
  return out;
}
