import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { compactMatch } from "../src/match.js";
import { addMatch, createStats, playerNameFiles, statsFiles } from "../src/stats.js";

const rawMatch = (over = {}) => ({
  info: {
    balls_per_over: 6,
    dates: ["2011-04-02"],
    gender: "male",
    match_type: "T20",
    team_type: "club",
    teams: ["A", "B"],
    outcome: { winner: "A", by: { runs: 9 } },
    players: { A: ["a1"], B: ["b1"] },
    registry: { people: { a1: "0000a001", b1: "0000b001" } },
    venue: "Ground, Town",
    ...over,
  },
  innings: [{ team: "A", overs: [{ over: 0, deliveries: [{ batter: "a1", bowler: "b1", non_striker: "a1", runs: { batter: 1, extras: 0, total: 1 } }] }] }],
});

test("hostile match_type, team and venue names never reach Object.prototype", () => {
  const stats = createStats();
  // JSON.parse makes "__proto__" an own key, as Cricsheet's file would; an object literal would not.
  const raw = JSON.parse(
    JSON.stringify(rawMatch({ match_type: "__proto__", teams: ["__proto__", "constructor"], players: {} })).replace(
      '"players":{}',
      '"players":{"__proto__":["a1"],"constructor":["b1"]}'
    )
  );
  raw.innings[0].team = "__proto__";
  const m = compactMatch("1", raw);
  addMatch(stats, m);
  for (const [, obj] of statsFiles(stats)) JSON.stringify(obj);
  playerNameFiles(stats);
  assert.equal({}.played, undefined);
  assert.equal(Object.keys(Object.prototype).length, 0);
  assert.equal({}[0], undefined);
});

test("a date that is not YYYY-MM-DD is skipped by the builder", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hist-"));
  const zip = new AdmZip();
  zip.addFile("1.json", Buffer.from(JSON.stringify(rawMatch())));
  zip.addFile("2.json", Buffer.from(JSON.stringify(rawMatch({ dates: ["../x"] }))));
  // The register is read from beside the archive; present, the build never goes to the network.
  fs.writeFileSync(path.join(tmp, "people.csv"), "identifier,name,unique_name,key_cricbuzz,key_cricinfo\n");
  fs.writeFileSync(path.join(tmp, "names.csv"), "identifier,name\n");
  const zipPath = path.join(tmp, "a.zip");
  zip.writeZip(zipPath);
  const out = path.join(tmp, "out");
  const build = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../build.mjs");
  const text = execFileSync("node", [build, zipPath, out], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.match(text, /parsed 1, skipped 1/);
  assert.ok(fs.existsSync(path.join(out, "idx/m/2011-04.json")));
  assert.ok(!fs.existsSync(path.join(tmp, "x.json")));
  fs.rmSync(tmp, { recursive: true, force: true });
});
