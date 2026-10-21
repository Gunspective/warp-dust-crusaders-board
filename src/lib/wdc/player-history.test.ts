// docs/HISTORY.md: the player history snapshot and the aggregation behind it.
import { describe, expect, it } from "vitest";
import { normalizeName } from "./elo";
import {
  aggregateHistory,
  gamesFromPairings,
  resultOf,
  type HistRecord,
  type PlayerHistorySnapshot,
} from "./history-aggregate";
import { factionKey, resolveFaction, type MatchupSnapshot } from "./matchups";
import matchupSnapshot from "./fixtures/matchups-sample.json";
import realSnapshot from "./player-history-snapshot.json";

const REAL = realSnapshot as unknown as PlayerHistorySnapshot;
const MATCHUPS = matchupSnapshot as unknown as MatchupSnapshot;
const fold = (name: string) => resolveFaction(MATCHUPS, name) ?? factionKey(name);

const statCheckNames = new Set<string>();
for (const [p, opps] of Object.entries(MATCHUPS.rows)) {
  statCheckNames.add(p);
  for (const o of Object.keys(opps)) statCheckNames.add(o);
}
/** A snapshot faction key: a Stat Check name, or a folded BCP name (factionKey is idempotent on it). */
const isFactionKey = (k: string) => statCheckNames.has(k) || (k !== "" && factionKey(k) === k);

const expectRecord = (rec: HistRecord, where: string) => {
  for (const f of ["g", "w", "d", "l"] as const) {
    expect(Number.isInteger(rec[f]), `${where}.${f} = ${rec[f]}`).toBe(true);
    expect(rec[f], `${where}.${f}`).toBeGreaterThanOrEqual(0);
  }
  expect(rec.g, `${where}: g = w + d + l`).toBe(rec.w + rec.d + rec.l);
};

const sum = (recs: HistRecord[]) => recs.reduce((s, r) => s + r.g, 0);

// The repo ships this snapshot empty; these checks run once scripts/bcp-history.mjs has written it.
describe.skipIf(Object.keys(REAL.players).length === 0)("player-history-snapshot.json (real)", () => {
  it("has the contract header", () => {
    expect(REAL.eventId).toBe("JkPs5aELBHPh");
    expect(Number.isNaN(Date.parse(REAL.generatedAt))).toBe(false);
    expect(REAL.windowStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(REAL.editionStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(REAL.editionStart >= REAL.windowStart).toBe(true);
    expect(Object.keys(REAL.players).length).toBeGreaterThan(100);
  });

  it("keys players by normalizeName of their display name", () => {
    for (const [key, p] of Object.entries(REAL.players)) {
      expect(p.name.trim()).not.toBe("");
      expect(normalizeName(p.name)).toBe(key);
    }
  });

  it("every record is whole, non-negative and g = w + d + l, with no NaN anywhere", () => {
    expect(JSON.stringify(REAL)).not.toMatch(/NaN|null|Infinity/);
    for (const [key, p] of Object.entries(REAL.players)) {
      expectRecord(p.year, `${key}.year`);
      expectRecord(p.ed11, `${key}.ed11`);
      expect(p.ed11.g).toBeLessThanOrEqual(p.year.g);
      for (const [f, r] of Object.entries(p.vs)) expectRecord(r, `${key}.vs.${f}`);
      for (const [k, a] of Object.entries(p.as)) {
        expectRecord(a, `${key}.as.${k}`);
        for (const [f, r] of Object.entries(a.vs)) expectRecord(r, `${key}.as.${k}.vs.${f}`);
        // A game without an opponent faction counts in the row but in no split.
        expect(sum(Object.values(a.vs))).toBeLessThanOrEqual(a.g);
      }
      expect(sum(Object.values(p.vs))).toBeLessThanOrEqual(p.ed11.g);
      expect(sum(Object.values(p.as))).toBeLessThanOrEqual(p.ed11.g);
    }
  });

  it("vs and as keys are Stat Check faction names or folded BCP names", () => {
    for (const [key, p] of Object.entries(REAL.players)) {
      for (const f of Object.keys(p.vs)) expect(isFactionKey(f), `${key}.vs ${f}`).toBe(true);
      for (const [k, a] of Object.entries(p.as)) {
        const bar = k.indexOf("|");
        expect(bar, `${key}.as ${k}`).toBeGreaterThan(0);
        expect(isFactionKey(k.slice(0, bar)), `${key}.as ${k}`).toBe(true);
        expect(k.slice(bar + 1)).not.toContain("|");
        for (const f of Object.keys(a.vs))
          expect(isFactionKey(f), `${key}.as.${k}.vs ${f}`).toBe(true);
      }
    }
  });
});

// Hand-made rows in the shape of /players/{eventPlayerId}/pairings.
const seat = (id: string, first: string, faction: string, subFaction?: string) => ({
  id,
  user: { id: `u-${id}`, firstName: first, lastName: "Test" },
  faction,
  ...(subFaction === undefined ? {} : { subFaction }),
});
const game = (result: number | null, points: number) => ({ result, points });
const row = (id: string, p1: unknown, g1: unknown, p2: unknown, g2: unknown, isDone = true) => ({
  id,
  pairingType: "Pairing",
  isDone,
  player1: p1,
  player1Game: g1,
  player2: p2,
  player2Game: g2,
});

describe("history aggregation", () => {
  it("reads result 2 as a win, 1 as a draw, 0 as a loss", () => {
    expect([resultOf(2), resultOf(1), resultOf(0), resultOf(null), resultOf(3)]).toEqual([
      "w",
      "d",
      "l",
      null,
      null,
    ]);
  });

  it("turns one player's pairing rows into games: either seat, byes and unfinished rows skipped", () => {
    const me = "EP1";
    const rows = [
      // player1, beats Necrons (points ignored: result is the authority)
      row(
        "r1",
        seat(me, "Me", "Space Marines (Astartes)", "Take and Hold"),
        game(2, 10),
        seat("o1", "A", "Necrons"),
        game(0, 10),
      ),
      // player2, draws Genestealer Cult (BCP spelling, Stat Check says Cults)
      row(
        "r2",
        seat("o2", "B", "Genestealer Cult"),
        game(1, 10),
        seat(me, "Me", "Space Marines (Astartes)", "Take and Hold"),
        game(1, 10),
      ),
      // the same row again: de-duplicated
      row(
        "r2",
        seat("o2", "B", "Genestealer Cult"),
        game(1, 10),
        seat(me, "Me", "Space Marines (Astartes)", "Take and Hold"),
        game(1, 10),
      ),
      // a bye: no opponent seat
      row(
        "r3",
        seat(me, "Me", "Space Marines (Astartes)", "Take and Hold"),
        game(2, 20),
        null,
        null,
      ),
      // a dashes seat is a bye too
      row(
        "r4",
        seat(me, "Me", "Space Marines (Astartes)"),
        game(2, 20),
        { id: "x", user: { firstName: "-", lastName: "-" } },
        game(0, 0),
      ),
      // not done yet
      row(
        "r5",
        seat(me, "Me", "Space Marines (Astartes)"),
        game(null, 0),
        seat("o5", "C", "Orks"),
        game(null, 0),
        false,
      ),
      // someone else's game
      row("r6", seat("o6", "D", "Orks"), game(2, 20), seat("o7", "E", "Tyranids"), game(0, 0)),
      // a loss with the seat's disposition missing: the entry's fallback applies
      row(
        "r7",
        seat("o8", "F", "Imperium"),
        game(2, 15),
        seat(me, "Me", "Space Marines (Astartes)"),
        game(0, 5),
      ),
    ];
    const t = gamesFromPairings(rows, {
      eventPlayerId: me,
      date: "2026-08-01",
      fold,
      fallbackDispo: "Take and Hold",
    });
    expect(t.byes).toBe(2);
    expect(t.unfinished).toBe(1);
    expect(t.mismatched).toBe(0);
    expect(t.games).toEqual([
      {
        date: "2026-08-01",
        result: "w",
        myFaction: "Space Marines",
        myDispo: "Take and Hold",
        oppFaction: "Necrons",
      },
      {
        date: "2026-08-01",
        result: "d",
        myFaction: "Space Marines",
        myDispo: "Take and Hold",
        oppFaction: "Genestealer Cults",
      },
      {
        date: "2026-08-01",
        result: "l",
        myFaction: "Space Marines",
        myDispo: "Take and Hold",
        oppFaction: "imperium",
      },
    ]);
  });

  it("aggregates year, ed11, vs and as with the window and edition cut-offs", () => {
    const ctx = (date: string) => ({ eventPlayerId: "EP", date, fold });
    const me = (f: string, d?: string) => seat("EP", "Me", f, d);
    const older = gamesFromPairings(
      [
        row("a1", me("Orks"), game(2, 20), seat("x1", "A", "Tyranids"), game(0, 0)),
        row("a2", me("Orks"), game(0, 0), seat("x2", "B", "Necrons"), game(2, 20)),
      ],
      ctx("2026-03-01"),
    ).games;
    const outside = gamesFromPairings(
      [row("b1", me("Orks"), game(2, 20), seat("x3", "C", "Necrons"), game(0, 0))],
      ctx("2025-09-01"),
    ).games;
    const newer = gamesFromPairings(
      [
        row("c1", me("Orks", "Purge the Foe"), game(2, 14), seat("x4", "D", "Necrons"), game(0, 6)),
        row(
          "c2",
          me("Orks", "Purge the Foe"),
          game(1, 10),
          seat("x5", "E", "Necrons"),
          game(1, 10),
        ),
        row(
          "c3",
          me("Orks", "Purge the Foe"),
          game(0, 3),
          seat("x6", "F", "Tyranids"),
          game(2, 17),
        ),
      ],
      ctx("2026-07-10"),
    ).games;
    const later = gamesFromPairings(
      [
        row(
          "d1",
          me("Orks", "Disruption"),
          game(2, 20),
          seat("x7", "G", "T'au Empire"),
          game(0, 0),
        ),
      ],
      ctx("2026-09-05"),
    ).games;
    const future = gamesFromPairings(
      [row("e1", me("Orks", "Disruption"), game(2, 20), seat("x8", "H", "Orks"), game(0, 0))],
      ctx("2026-12-01"),
    ).games;

    const h = aggregateHistory("Me Test", [...older, ...outside, ...newer, ...later, ...future], {
      windowStart: "2025-10-18",
      editionStart: "2026-06-20",
      through: "2026-10-18",
    });
    expect(h.name).toBe("Me Test");
    expect(h.year).toEqual({ g: 6, w: 3, d: 1, l: 2 });
    expect(h.ed11).toEqual({ g: 4, w: 2, d: 1, l: 1 });
    expect(h.vs).toEqual({
      Necrons: { g: 2, w: 1, d: 1, l: 0 },
      "T'au Empire": { g: 1, w: 1, d: 0, l: 0 },
      Tyranids: { g: 1, w: 0, d: 0, l: 1 },
    });
    expect(h.as).toEqual({
      "Orks|Disruption": {
        g: 1,
        w: 1,
        d: 0,
        l: 0,
        vs: { "T'au Empire": { g: 1, w: 1, d: 0, l: 0 } },
      },
      "Orks|Purge the Foe": {
        g: 3,
        w: 1,
        d: 1,
        l: 1,
        vs: { Necrons: { g: 2, w: 1, d: 1, l: 0 }, Tyranids: { g: 1, w: 0, d: 0, l: 1 } },
      },
    });
  });

  it("keeps a game with no opponent faction in the totals and its as row but in no vs split", () => {
    const games = gamesFromPairings(
      [row("n1", seat("EP", "Me", "Aeldari", ""), game(2, 20), seat("o", "A", ""), game(0, 0))],
      { eventPlayerId: "EP", date: "2026-07-01", fold },
    ).games;
    const h = aggregateHistory("Me", games, {
      windowStart: "2025-10-18",
      editionStart: "2026-06-20",
    });
    expect(h.ed11).toEqual({ g: 1, w: 1, d: 0, l: 0 });
    expect(h.vs).toEqual({});
    expect(h.as).toEqual({ "Aeldari|": { g: 1, w: 1, d: 0, l: 0, vs: {} } });
  });
});

describe("games with no opponent recorded (owner 2026-10-18)", () => {
  it("counts a played 12-point win with no opponent and still skips a flat-20 bye and a 0-point forfeit", () => {
    const ctx = { eventPlayerId: "me", date: "2026-06-26", fold: (f: string) => f };
    const rows = [
      {
        id: "a",
        isDone: true,
        player1Id: "me",
        player1: { id: "me" },
        player1Game: { result: 2, points: 12 },
      },
      {
        id: "b",
        isDone: true,
        player1Id: "me",
        player1: { id: "me" },
        player1Game: { result: 2, points: 20 },
      },
      {
        id: "c",
        isDone: true,
        player1Id: "me",
        player1: { id: "me" },
        player1Game: { result: 0, points: 0 },
      },
    ];
    const t = gamesFromPairings(rows, ctx);
    expect(t.games.map((g) => g.result)).toEqual(["w"]);
    expect(t.games[0].oppFaction).toBe("");
    expect(t.byes).toBe(2);
  });
});
