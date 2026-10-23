/**
 * One Cricsheet match file -> the compact match the app downloads, plus its scorecard.
 *
 * Every match is kept, whatever its format: unlike the win-probability corpus, nothing here is
 * modelled, so a 1990s Test is as valid as last week's T20.
 *
 * People are indexed into the match's own `p` list ([name, registryId]) and every delivery,
 * scorecard row and wicket refers to them by that index. Keys are short because the file is the
 * payload: a Test has ~2,000 deliveries.
 */

/** Bits of a delivery's extras field (`x`). */
export const X = { WIDE: 1, NOBALL: 2, BYE: 4, LEGBYE: 8, PENALTY: 16, NON_BOUNDARY: 32 };

/** Dismissals that are not a wicket for the team total. */
const NOT_A_WICKET = new Set(["retired hurt", "retired not out"]);
/** Dismissals the bowler is not credited with. */
const NOT_BOWLERS_WICKET = new Set([
  "run out", "retired hurt", "retired out", "retired not out", "obstructing the field", "timed out",
  "handled the ball",
]);

export const SCHEMA_VERSION = 1;

export function compactMatch(id, raw) {
  const info = raw?.info ?? {};
  const teams = info.teams ?? [];
  if (teams.length !== 2) return null;

  const registry = info.registry?.people ?? {};
  const people = [];
  const indexByName = new Map();
  const indexOf = (name) => {
    if (!name) return -1;
    let idx = indexByName.get(name);
    if (idx === undefined) {
      idx = people.length;
      people.push(registry[name] ? [name, registry[name]] : [name]);
      indexByName.set(name, idx);
    }
    return idx;
  };
  const teamIndex = (name) => teams.indexOf(name);
  for (const team of teams) for (const name of info.players?.[team] ?? []) indexOf(name);

  const ballsPerOver = info.balls_per_over ?? 6;
  const innings = (raw.innings ?? []).map((inning) => compactInnings(inning, { indexOf, teamIndex, ballsPerOver }));
  const outcome = info.outcome ?? {};

  const match = {
    v: SCHEMA_VERSION,
    id: String(id),
    d: info.dates?.[0] ?? null,
    ds: info.dates?.length ?? 1,
    f: info.match_type ?? null,
    g: info.gender ?? "male",
    tt: info.team_type ?? null,
    t: teams,
    e: info.event ? { n: info.event.name ?? null, mn: info.event.match_number ?? null, st: info.event.stage ?? null } : null,
    ven: info.venue ?? null,
    city: info.city ?? null,
    toss: info.toss?.winner ? [teamIndex(info.toss.winner), info.toss.decision ?? null] : null,
    o: {
      w: outcome.winner ? teamIndex(outcome.winner) : -1,
      by: outcome.by ?? null,
      r: outcome.result ?? null,
      m: outcome.method ?? null,
      el: outcome.eliminator ? teamIndex(outcome.eliminator) : (outcome.bowl_out ? teamIndex(outcome.bowl_out) : -1),
    },
    pom: (info.player_of_match ?? []).map(indexOf),
    xi: teams.map((team) => (info.players?.[team] ?? []).map(indexOf)),
    bpo: ballsPerOver,
    p: people,
    inn: innings,
  };
  return match;
}

function compactInnings(inning, { indexOf, teamIndex, ballsPerOver }) {
  const b = [];
  const order = [];
  const seen = new Set();
  const appear = (idx) => {
    if (idx >= 0 && !seen.has(idx)) {
      seen.add(idx);
      order.push(idx);
    }
  };
  const bowlOrder = [];
  const bowlSeen = new Set();

  const bat = new Map();
  const bowl = new Map();
  const batRow = (idx) => {
    if (!bat.has(idx)) bat.set(idx, { r: 0, b: 0, f4: 0, s6: 0, how: null });
    return bat.get(idx);
  };
  const bowlRow = (idx) => {
    if (!bowl.has(idx)) bowl.set(idx, { balls: 0, maidens: 0, runs: 0, wk: 0, wd: 0, nb: 0 });
    return bowl.get(idx);
  };
  const ext = { b: 0, lb: 0, w: 0, nb: 0, p: 0 };
  let total = 0;
  let wickets = 0;
  let legalBalls = 0;
  const fow = [];
  const ov = [];

  for (const over of inning?.overs ?? []) {
    const o = over.over ?? 0;
    let legalInOver = 0;
    let overRuns = 0;
    let overWkts = 0;
    let overConceded = 0;
    const overBowlers = new Set();

    for (const d of over.deliveries ?? []) {
      const bt = indexOf(d.batter);
      const bw = indexOf(d.bowler);
      const ns = indexOf(d.non_striker);
      appear(bt);
      appear(ns);
      if (!bowlSeen.has(bw)) {
        bowlSeen.add(bw);
        bowlOrder.push(bw);
      }
      overBowlers.add(bw);

      const e = d.extras ?? {};
      const rb = d.runs?.batter ?? 0;
      const re = d.runs?.extras ?? 0;
      const rt = d.runs?.total ?? rb + re;
      let x = 0;
      if (e.wides != null) x |= X.WIDE;
      if (e.noballs != null) x |= X.NOBALL;
      if (e.byes != null) x |= X.BYE;
      if (e.legbyes != null) x |= X.LEGBYE;
      if (e.penalty != null) x |= X.PENALTY;
      if (d.runs?.non_boundary) x |= X.NON_BOUNDARY;
      const legal = !(x & (X.WIDE | X.NOBALL));

      // The ball label Cricsheet and scorers use: a wide keeps the number of the ball it replaces.
      const s = legalInOver + 1;
      if (legal) {
        legalInOver += 1;
        legalBalls += 1;
      }

      const striker = batRow(bt);
      striker.r += rb;
      if (!(x & X.WIDE)) striker.b += 1;
      if (rb === 4 && !(x & X.NON_BOUNDARY)) striker.f4 += 1;
      if (rb === 6 && !(x & X.NON_BOUNDARY)) striker.s6 += 1;
      batRow(ns);

      const bowler = bowlRow(bw);
      const conceded = rb + (e.wides ?? 0) + (e.noballs ?? 0);
      bowler.runs += conceded;
      overConceded += conceded;
      if (legal) bowler.balls += 1;
      bowler.wd += e.wides ?? 0;
      bowler.nb += e.noballs ?? 0;

      ext.b += e.byes ?? 0;
      ext.lb += e.legbyes ?? 0;
      ext.w += e.wides ?? 0;
      ext.nb += e.noballs ?? 0;
      ext.p += e.penalty ?? 0;
      total += rt;
      overRuns += rt;

      const tuple = [o, s, bt, bw, ns, rb, re, x];
      const wk = [];
      for (const w of d.wickets ?? []) {
        const out = indexOf(w.player_out);
        appear(out);
        const fielders = (w.fielders ?? []).map((f) => indexOf(f.name));
        wk.push([w.kind, out, ...fielders]);
        batRow(out).how = howOut(w.kind, d.bowler, (w.fielders ?? []).map((f) => f.name), !!w.fielders?.[0]?.substitute);
        if (!NOT_A_WICKET.has(w.kind)) {
          wickets += 1;
          overWkts += 1;
          fow.push([total, wickets, out, `${o}.${s}`]);
        }
        if (!NOT_BOWLERS_WICKET.has(w.kind)) bowler.wk += 1;
      }
      if (wk.length) tuple.push(wk);
      b.push(tuple);
    }

    // A maiden is a complete over by one bowler that cost the bowler nothing.
    if (overBowlers.size === 1 && legalInOver >= ballsPerOver && overConceded === 0) {
      bowlRow([...overBowlers][0]).maidens += 1;
    }
    ov.push([overRuns, overWkts]);
  }

  const penalty = (inning?.penalty_runs?.pre ?? 0) + (inning?.penalty_runs?.post ?? 0);
  total += penalty;
  ext.p += penalty;

  return {
    t: teamIndex(inning?.team),
    so: inning?.super_over ? 1 : 0,
    dec: inning?.declared ? 1 : 0,
    tgt: inning?.target ? [inning.target.runs ?? null, inning.target.overs ?? null] : null,
    b,
    sc: {
      bat: order.map((idx) => {
        const r = bat.get(idx) ?? { r: 0, b: 0, f4: 0, s6: 0, how: null };
        return [idx, r.r, r.b, r.f4, r.s6, r.how];
      }),
      bowl: bowlOrder.map((idx) => {
        const r = bowl.get(idx);
        return [idx, r.balls, r.maidens, r.runs, r.wk, r.wd, r.nb];
      }),
      ext: [ext.b, ext.lb, ext.w, ext.nb, ext.p],
      tot: [total, wickets, legalBalls],
      fow,
    },
    ov,
  };
}

/** The scorecard's dismissal line, as scorers write it. Null means not out. */
export function howOut(kind, bowler, fielders, substitute) {
  const f = fielders[0] ? `${substitute ? "sub (" + fielders[0] + ")" : fielders[0]}` : null;
  switch (kind) {
    case "caught":
      return f ? `c ${f} b ${bowler}` : `c ? b ${bowler}`;
    case "caught and bowled":
      return `c & b ${bowler}`;
    case "bowled":
      return `b ${bowler}`;
    case "lbw":
      return `lbw b ${bowler}`;
    case "stumped":
      return f ? `st ${f} b ${bowler}` : `st b ${bowler}`;
    case "hit wicket":
      return `hit wicket b ${bowler}`;
    case "run out":
      return fielders.length ? `run out (${fielders.join("/")})` : "run out";
    default:
      return kind;
  }
}
