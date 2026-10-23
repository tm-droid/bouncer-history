import { test } from "node:test";
import assert from "node:assert/strict";
import { compactMatch, howOut, X } from "../src/match.js";
import { addMatch, createStats, formatKey, playerNameFiles, resultFor, statsFiles, venueIndex } from "../src/stats.js";
import { pairKey, teamKey } from "../src/keys.js";

const d = (batter, bowler, nonStriker, bat, extras = {}, extra = {}) => ({
  batter,
  bowler,
  non_striker: nonStriker,
  runs: { batter: bat, extras: Object.values(extras).reduce((a, b) => a + b, 0), total: bat + Object.values(extras).reduce((a, b) => a + b, 0) },
  ...(Object.keys(extras).length ? { extras } : {}),
  ...extra,
});

// Two overs for A, one for B. Over 0 (Z bowls): a wide, a no-ball four, a leg-bye, a caught, a
// six and a dot. Over 1 (Y bowls): a maiden of six dots. B's innings ends at a run out.
const raw = {
  info: {
    balls_per_over: 6,
    city: "Kolkata",
    dates: ["2011-04-02"],
    event: { name: "Test Cup", match_number: 1 },
    gender: "male",
    match_type: "T20",
    team_type: "international",
    teams: ["A", "B"],
    toss: { winner: "B", decision: "field" },
    outcome: { winner: "A", by: { runs: 9 } },
    player_of_match: ["a1"],
    players: { A: ["a1", "a2", "a3"], B: ["z", "y", "b1"] },
    registry: { people: { a1: "0000a001", a2: "0000a002", a3: "0000a003", z: "0000000f", y: "0000000e", b1: "0000b001" } },
    venue: "Eden Gardens, Kolkata",
  },
  innings: [
    {
      team: "A",
      overs: [
        {
          over: 0,
          deliveries: [
            d("a1", "z", "a2", 0, { wides: 1 }),
            d("a1", "z", "a2", 4, { noballs: 1 }),
            d("a1", "z", "a2", 0, { legbyes: 1 }),
            d("a2", "z", "a1", 0, {}, { wickets: [{ player_out: "a2", kind: "caught", fielders: [{ name: "y" }] }] }),
            d("a3", "z", "a1", 6),
            d("a3", "z", "a1", 0),
            d("a3", "z", "a1", 0),
          ],
        },
        { over: 1, deliveries: Array.from({ length: 6 }, () => d("a1", "y", "a3", 0)) },
      ],
    },
    {
      team: "B",
      overs: [
        {
          over: 0,
          deliveries: [
            d("b1", "a1", "z", 0, { byes: 1 }),
            d("z", "a1", "b1", 0, {}, { wickets: [{ player_out: "z", kind: "run out", fielders: [{ name: "a2" }, { name: "a3" }] }] }),
          ],
        },
      ],
    },
  ],
};

const m = compactMatch("12345", raw);
const idx = (name) => m.p.findIndex((p) => p[0] === name);

test("match header keeps teams, toss, outcome and people with registry ids", () => {
  assert.equal(m.id, "12345");
  assert.equal(m.d, "2011-04-02");
  assert.deepEqual(m.t, ["A", "B"]);
  assert.deepEqual(m.toss, [1, "field"]);
  assert.equal(m.o.w, 0);
  assert.deepEqual(m.o.by, { runs: 9 });
  assert.deepEqual(m.p[idx("a1")], ["a1", "0000a001"]);
  assert.deepEqual(m.pom, [idx("a1")]);
});

test("scorecard totals add up: batter runs plus extras is the innings total", () => {
  const sc = m.inn[0].sc;
  const batRuns = sc.bat.reduce((s, r) => s + r[1], 0);
  const extras = sc.ext.reduce((s, x) => s + x, 0);
  assert.equal(sc.tot[0], batRuns + extras);
  assert.equal(sc.tot[0], 13); // wide 1, no-ball 4+1, leg-bye 1, six
  assert.deepEqual(sc.ext, [0, 1, 1, 1, 0]);
  assert.equal(sc.tot[1], 1);
  assert.equal(sc.tot[2], 11); // 13 deliveries, a wide and a no-ball are not legal
  const overRuns = m.inn[0].ov.reduce((s, o) => s + o[0], 0);
  assert.equal(overRuns, sc.tot[0]);
});

test("balls faced skip wides only; boundaries counted; dismissal line written", () => {
  const a1 = m.inn[0].sc.bat.find((r) => r[0] === idx("a1"));
  // wide (not faced), no-ball four (faced), leg-bye (faced) + six dots in over 1
  assert.deepEqual(a1.slice(1, 5), [4, 8, 1, 0]);
  assert.equal(a1[5], null);
  const a2 = m.inn[0].sc.bat.find((r) => r[0] === idx("a2"));
  assert.equal(a2[5], "c y b z");
  const a3 = m.inn[0].sc.bat.find((r) => r[0] === idx("a3"));
  assert.deepEqual(a3.slice(1, 5), [6, 3, 0, 1]);
});

test("bowling: runs conceded exclude byes and leg-byes; a clean over is a maiden", () => {
  const z = m.inn[0].sc.bowl.find((r) => r[0] === idx("z"));
  assert.deepEqual(z.slice(1), [5, 0, 12, 1, 1, 1]); // 5 legal, 1+5+6 conceded, 1 wicket
  const y = m.inn[0].sc.bowl.find((r) => r[0] === idx("y"));
  assert.deepEqual(y.slice(1), [6, 1, 0, 0, 0, 0]);
});

test("delivery tuples carry the ball label scorers use and the extras bits", () => {
  const [wide, noball] = m.inn[0].b;
  assert.equal(wide[1], 1);
  assert.equal(wide[7] & X.WIDE, X.WIDE);
  assert.equal(noball[1], 1); // the no-ball is re-bowled as the same ball
  assert.equal(noball[7] & X.NOBALL, X.NOBALL);
  const caught = m.inn[0].b[3];
  assert.equal(caught[1], 2);
  assert.deepEqual(caught[8], [["caught", idx("a2"), idx("y")]]);
  assert.deepEqual(m.inn[0].sc.fow, [[7, 1, idx("a2"), "0.2"]]);
});

test("run out is not the bowler's wicket", () => {
  const a1 = m.inn[1].sc.bowl.find((r) => r[0] === idx("a1"));
  assert.equal(a1[4], 0);
  assert.equal(m.inn[1].sc.tot[1], 1);
  assert.equal(m.inn[1].sc.bat.find((r) => r[0] === idx("z"))[5], "run out (a2/a3)");
});

test("howOut covers the common kinds", () => {
  assert.equal(howOut("bowled", "X", [], false), "b X");
  assert.equal(howOut("lbw", "X", [], false), "lbw b X");
  assert.equal(howOut("stumped", "X", ["K"], false), "st K b X");
  assert.equal(howOut("caught and bowled", "X", ["X"], false), "c & b X");
  assert.equal(howOut("caught", "X", ["S"], true), "c sub (S) b X");
  assert.equal(howOut("retired hurt", "X", [], false), "retired hurt");
});

test("format key splits T20 internationals from league T20s", () => {
  assert.equal(formatKey(m), "T20I");
  assert.equal(formatKey({ f: "T20", tt: "club" }), "T20");
  assert.equal(formatKey({ f: "Test", tt: "international" }), "Test");
});

test("stats: team, pair, venue and player records from one match", () => {
  const stats = createStats();
  addMatch(stats, m);
  const files = new Map(statsFiles(stats));
  assert.deepEqual(files.get(`s/team/${teamKey("A", "male")}.json`).f.T20I, [1, 1, 0, 0, 0, 0]);
  assert.deepEqual(files.get(`s/team/${teamKey("B", "male")}.json`).f.T20I, [1, 0, 1, 0, 0, 0]);
  const pair = files.get(`s/h2h/${pairKey("B", "A", "male")}.json`);
  assert.deepEqual(pair.t, ["A", "B"]);
  assert.deepEqual(pair.f.T20I, [1, 1, 0, 0, 0, 0]);
  assert.ok([...files.keys()].some((k) => k.startsWith("s/venue/eden-gardens")));
  const a1 = files.get("s/p/0000a001.json");
  // played, innings, not outs, runs, balls, high score, not out, 50s, 100s, balls bowled,
  // conceded, wickets, best w, best r, catches, stumpings, fours, sixes, 4w, 5w
  assert.deepEqual(a1.f.T20I, [1, 1, 1, 4, 8, 4, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
  assert.deepEqual(files.get("s/p/0000000e.json").f.T20I.slice(9, 15), [6, 0, 0, 0, 0, 1]);
  const names = new Map(playerNameFiles(stats));
  assert.ok(names.get("s/p/names/a.json").some((r) => r[1] === "0000a001"));
});

test("venue index lists each ground once with its file key, name, city and match count", () => {
  const stats = createStats();
  addMatch(stats, m);
  const rows = venueIndex(stats);
  assert.equal(rows.length, 1);
  const [key, name, city, matches] = rows[0];
  assert.ok(new Map(statsFiles(stats)).has(`s/venue/${key}.json`));
  assert.deepEqual([name, city, matches], [m.ven, "Kolkata", 1]);
});

test("results from one side's view", () => {
  assert.equal(resultFor(m, 0), "W");
  assert.equal(resultFor(m, 1), "L");
  assert.equal(resultFor({ o: { w: -1, r: "draw" } }, 0), "D");
  assert.equal(resultFor({ o: { w: -1, r: "tie" } }, 0), "T");
  assert.equal(resultFor({ o: { w: -1, r: "no result" } }, 0), "N");
});

test("women's sides get their own keys", () => {
  assert.equal(teamKey("India", "female"), "india__w");
  assert.equal(pairKey("India", "Australia", "female"), "australia__india__w");
  assert.equal(pairKey("Sri Lanka", "India", "male"), "india__sri-lanka");
});

test("a registry id that is not Cricsheet's 8-hex form never becomes a file", () => {
  const evil = structuredClone(raw);
  evil.info.registry.people.a1 = "../../../etc/x";
  const stats = createStats();
  addMatch(stats, compactMatch("1", evil));
  const paths = [...statsFiles(stats)].map(([p]) => p);
  assert.ok(paths.every((p) => !p.includes("..")));
  assert.ok(!paths.includes("s/p/../../../etc/x.json"));
});

test("career 4s, 6s and 4/5-wicket hauls: non-boundary and run outs do not count", () => {
  const ball = (bat, bowler, extra = {}) => d("a1", bowler, "a2", bat, {}, extra);
  const wkt = (kind) => ({ wickets: [{ player_out: "a2", kind }] });
  const hauls = [...Array.from({ length: 4 }, () => ball(0, "z", wkt("bowled"))), ball(0, "z", wkt("run out"))];
  const five = [...hauls, ball(0, "z", wkt("lbw"))];
  const mk = (id, dels) => compactMatch(id, {
    ...raw,
    innings: [{ team: "A", overs: [{ over: 0, deliveries: dels }] }],
  });
  const stats = createStats();
  // 4 boundary + 4 non-boundary (not a four) + 6 + 6 non-boundary (not a six); 4 bowled wickets plus a run out
  addMatch(stats, mk("1", [
    ball(4, "z"), { ...ball(4, "z"), runs: { batter: 4, extras: 0, total: 4, non_boundary: true } },
    ball(6, "z"), { ...ball(6, "z"), runs: { batter: 6, extras: 0, total: 6, non_boundary: true } },
    ...hauls,
  ]));
  addMatch(stats, mk("2", five));
  const files = new Map(statsFiles(stats));
  const a1 = files.get("s/p/0000a001.json").f.T20I;
  assert.deepEqual(a1.slice(16), [1, 1, 0, 0]);
  const z = files.get("s/p/0000000f.json").f.T20I;
  // match 1: 4 wickets (run out excluded) -> 4w; match 2: 5 wickets (4 + lbw) -> 4w and 5w
  assert.deepEqual([z[11], ...z.slice(16)], [9, 0, 0, 2, 1]);
});
