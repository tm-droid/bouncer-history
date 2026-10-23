import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as mine from "../src/names.js";

// In the app repo the copy must behave as the original; in the public repo the original is absent.
test("names.js agrees with train-win-probability's contextmath.js", async (t) => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const original = path.resolve(here, "../../../functions/train-win-probability/src/contextmath.js");
  if (!fs.existsSync(original)) return t.skip("train-win-probability is not beside this copy (the public repo)");
  const theirs = await import(original);
  for (const s of ["Eden Gardens, Kolkata", "Mäkelä Oval", "  County  Ground ", "St. George's Park", "", null, undefined, "A,B,C"]) {
    assert.equal(mine.squash(s), theirs.squash(s));
    assert.equal(mine.venueName(s), theirs.venueName(s));
    for (const c of ["Kolkata", "", null, "Saint-Denis"]) assert.equal(mine.venueKey(s, c), theirs.venueKey(s, c));
  }
});
