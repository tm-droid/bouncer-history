import test from "node:test";
import assert from "node:assert/strict";
import {
  biosByRegId, commonsTitle, dobById, firstById, isFreeLicense, parseImageInfo, photoFor, rows, stripHtml,
} from "../src/wikidata.mjs";

const lit = (value) => ({ type: "literal", value });

test("rows flattens SPARQL bindings and drops rows without an id", () => {
  const json = { results: { bindings: [{ id: lit("1"), v: lit("a") }, { v: lit("x") }] } };
  assert.deepEqual(rows(json), [{ id: "1", v: "a" }]);
  assert.deepEqual(rows(null), []);
});

test("dobById keeps precision, prefers the preferred rank, ignores deprecated-precision values", () => {
  const P = "http://wikiba.se/ontology#PreferredRank";
  const N = "http://wikiba.se/ontology#NormalRank";
  const m = dobById([
    { id: "1", v: "1988-11-05T00:00:00Z", p: "11", r: N },
    { id: "1", v: "1989-01-01T00:00:00Z", p: "9", r: P },
    { id: "2", v: "1877-11-02T00:00:00Z", p: "11", r: N },
    { id: "3", v: "1800-01-01T00:00:00Z", p: "7", r: N },
    { id: "4", v: "1900-03-01T00:00:00Z", p: "10", r: N },
    { id: "5", v: "-0500-01-01T00:00:00Z", p: "11", r: N },
  ]);
  assert.equal(m.get("1"), "1989");
  assert.equal(m.get("2"), "1877-11-02");
  assert.equal(m.has("3"), false);
  assert.equal(m.get("4"), "1900-03");
  assert.equal(m.has("5"), false);
});

test("firstById keeps the first value per id", () => {
  assert.equal(firstById([{ id: "1", v: "a" }, { id: "1", v: "b" }]).get("1"), "a");
});

test("commonsTitle decodes a FilePath URL", () => {
  assert.equal(commonsTitle("http://commons.wikimedia.org/wiki/Special:FilePath/Victor%20Trumper%20c1905.jpg"), "File:Victor Trumper c1905.jpg");
  assert.equal(commonsTitle("https://example.com/x.jpg"), null);
  assert.equal(commonsTitle("http://commons.wikimedia.org/wiki/Special:FilePath/%E0%A4%A"), null);
});

test("stripHtml gives plain bounded text", () => {
  assert.equal(stripHtml('<a href="//x">John &amp; <b>Doe</b></a><br>&#169; 2020&nbsp;'), "John & Doe © 2020");
  assert.equal(stripHtml("<script>x</script>&lt;b&gt;"), "xb");
  assert.ok(stripHtml("a".repeat(200)).length <= 80);
  assert.equal(stripHtml(undefined), "");
});

test("isFreeLicense drops missing, fair use and non-free", () => {
  const meta = (name, extra = {}) => ({ LicenseShortName: { value: name }, ...extra });
  assert.equal(isFreeLicense(meta("CC BY-SA 4.0")), true);
  assert.equal(isFreeLicense(meta("Public domain")), true);
  assert.equal(isFreeLicense(meta("Fair use")), false);
  assert.equal(isFreeLicense(meta("Non-free media")), false);
  assert.equal(isFreeLicense(meta("CC BY 2.0", { NonFree: { value: "true" } })), false);
  assert.equal(isFreeLicense({}), false);
  assert.equal(isFreeLicense(undefined), false);
});

const page = (title, info) => ({ title, imageinfo: [info] });
const good = {
  thumburl: "https://upload.wikimedia.org/t/330px-A.jpg?utm_source=commons",
  descriptionurl: "https://commons.wikimedia.org/wiki/File:A.jpg",
  extmetadata: {
    Artist: { value: '<a href="x">Jane</a>' },
    LicenseShortName: { value: "CC BY-SA 4.0" },
    LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0" },
  },
};

test("parseImageInfo keeps free files, follows normalisation and redirects", () => {
  const json = {
    query: {
      normalized: [{ from: "File:a_b.jpg", to: "File:A b.jpg" }],
      redirects: [{ from: "File:A b.jpg", to: "File:A.jpg" }],
      pages: {
        1: page("File:A.jpg", good),
        2: page("File:Bad.jpg", { ...good, extmetadata: { LicenseShortName: { value: "Fair use" } } }),
        3: page("File:NoLic.jpg", { ...good, extmetadata: {} }),
        4: page("File:Http.jpg", { ...good, thumburl: "http://x/y.jpg" }),
        5: { title: "File:Missing.jpg", missing: "" },
      },
    },
  };
  const parsed = parseImageInfo(json);
  assert.deepEqual([...parsed.byTitle.keys()], ["File:A.jpg"]);
  assert.deepEqual(photoFor(parsed, "File:a_b.jpg"), {
    img: "https://upload.wikimedia.org/t/330px-A.jpg", ip: good.descriptionurl, il: "CC BY-SA 4.0", ia: "Jane", ilu: good.extmetadata.LicenseUrl.value,
  });
  assert.equal(photoFor(parsed, "File:Bad.jpg"), null);
});

test("biosByRegId joins on the Cricinfo id and skips players without data", () => {
  const register = { ids: new Map([["r1", { ci: "10" }], ["r2", { ci: "11" }], ["r3", { cb: "5" }]]), names: new Map() };
  const data = {
    dob: { 10: "1988-11-05" },
    place: { 10: "Delhi" },
    article: { 10: "https://en.wikipedia.org/wiki/X", 11: "https://evil.example/x" },
    photo: { 10: { img: "https://u/x.jpg", il: "CC0" } },
  };
  const out = biosByRegId(register, data);
  assert.deepEqual(out.get("r1"), { b: "1988-11-05", bp: "Delhi", wp: "https://en.wikipedia.org/wiki/X", img: "https://u/x.jpg", il: "CC0" });
  assert.equal(out.has("r2"), false);
  assert.equal(out.has("r3"), false);
  assert.equal(biosByRegId(null, data).size, 0);
});
