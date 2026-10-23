import { test } from "node:test";
import assert from "node:assert/strict";
import { aliasesFor, parseCsv, parseRegister } from "../src/register.js";
import { addMatch, createStats, playerNameFiles, statsFiles } from "../src/stats.js";
import { compactMatch } from "../src/match.js";

const PEOPLE = [
  "identifier,name,unique_name,key_bcci,key_cricbuzz,key_cricinfo",
  '0000a001,A One,"A One",,4881,253802',
  "0000a002,A Two,A Two,,../x,not-a-number",
  "0000b001,B One,B One,,,77",
].join("\r\n");
const NAMES = ['identifier,name', "0000a001,A One", '0000a001,"One, Alias"', "0000a001,Anne Zed", "0000a001,Andrew One", "0000a001,Anne Zed"].join("\n");

test("csv: quotes, doubled quotes, CRLF", () => {
  assert.deepEqual(parseCsv('a,"b,""c""",d\r\ne,f\n'), [["a", 'b,"c"', "d"], ["e", "f"]]);
});

test("register keeps only plain numeric ids", () => {
  const { ids } = parseRegister(PEOPLE, NAMES);
  assert.deepEqual(ids.get("0000a001"), { cb: "4881", ci: "253802" });
  assert.equal(ids.has("0000a002"), false);
  assert.deepEqual(ids.get("0000b001"), { ci: "77" });
});

test("a changed header fails loudly instead of dropping every id", () => {
  assert.throws(() => parseRegister("id,nm\n1,2", NAMES), /header changed/);
});

test("aliases: only a surname the primary lacks, deduplicated, capped", () => {
  assert.deepEqual(aliasesFor("A One", ["A One", "Andrew One", "Anne Other", "Anne Other", "X Y", "X Z", "X W"]), ["Anne Other", "X Y", "X Z"]);
  assert.deepEqual(aliasesFor("A One", undefined), []);
});

test("player records and name rows carry the ids; alias rows sit under their own letter", () => {
  const stats = createStats();
  const raw = {
    info: {
      balls_per_over: 6, dates: ["2011-04-02"], gender: "male", match_type: "T20", team_type: "club", teams: ["A", "B"],
      outcome: { winner: "A", by: { runs: 9 } }, players: { A: ["A One"], B: ["B One"] },
      registry: { people: { "A One": "0000a001", "B One": "0000b001" } }, venue: "G, T",
    },
    innings: [{ team: "A", overs: [{ over: 0, deliveries: [{ batter: "A One", bowler: "B One", non_striker: "A One", runs: { batter: 1, extras: 0, total: 1 } }] }] }],
  };
  addMatch(stats, compactMatch("1", raw));
  const register = parseRegister(PEOPLE, NAMES);
  const records = new Map([...statsFiles(stats, register)].map(([p, o]) => [p, o]));
  assert.equal(records.get("s/p/0000a001.json").cb, "4881");
  assert.equal(records.get("s/p/0000a001.json").ci, "253802");
  assert.equal(records.get("s/p/0000b001.json").cb, undefined);
  const names = new Map(playerNameFiles(stats, register));
  assert.deepEqual(names.get("s/p/names/o.json").find((r) => r[0] === "A One"), ["A One", "0000a001", "A", 1, "4881"]);
  assert.deepEqual(names.get("s/p/names/o.json").find((r) => r[0] === "B One"), ["B One", "0000b001", "B", 1]);
  assert.deepEqual(names.get("s/p/names/z.json"), [["Anne Zed", "0000a001", "A", 1, "4881"]]);
  assert.equal(names.get("s/p/names/o.json").length, 2); // "Andrew One" shares the surname: no row
  // without a register nothing changes
  assert.deepEqual([...playerNameFiles(stats)][0][1][0].length, 4);
});
