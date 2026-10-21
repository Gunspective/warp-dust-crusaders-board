// @vitest-environment node
//
// State layer for the coach board (docs/CONTRACT.md C2, C3, C5, C6): the BCP + coach merge, the
// PIN-gated save, and the offline fallback. BCP data is the real TEO-8 fixtures through
// loadBcpSnapshot with an injected fetch; Workers KV is a fake with the get/put surface the code uses.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import eventFixture from "./fixtures/event.json";
import standingsFixture from "./fixtures/standings.json";
import round1PairingFixture from "./fixtures/round1-pairing.json";
import round1TeamPairingFixture from "./fixtures/round1-teampairing.json";
import round2PairingFixture from "./fixtures/round2-pairing.json";
import round2TeamPairingFixture from "./fixtures/round2-teampairing.json";
import { tableScore, withPairing, withTable } from "../../components/wdc/model";
import { bcpTeamKey, loadBcpSnapshot, resetBcpCacheForTests, type BcpFetch } from "./bcp.server";
import type { EloSnapshot } from "./elo";
import { teamKey } from "./keys";
import {
  checkSaveInput,
  emptyCoach,
  hexEqual,
  loadBoard,
  mergeBoard,
  parseCoachState,
  saveCoach,
  secretPinHash,
  sha256Hex,
  WDC_PIN_FAILS_KEY,
  WDC_KV_RETRY_MS,
  WDC_KV_WRITE_TRIES,
  WDC_PIN_KEY,
  WDC_SAVE_MAX_BYTES,
  WDC_SNAPSHOT_REFRESH_MS,
  WDC_SNAPSHOT_STALE_MS,
  wdcSnapshotKey,
  wdcStateKey,
  type WdcKv,
  type WdcSnapshotInput,
} from "./state.server";
import {
  forecastPoints,
  type WdcBoardState,
  type WdcCoachRound,
  type WdcCoachState,
  type WdcRound,
  type WdcTable,
} from "./types";

const EVENT = "JkPs5aELBHPh";
const OUR = "Warp Dust Crusaders";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fixtureFetch = () =>
  vi.fn<BcpFetch>(async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/teamPlayers")) return json(standingsFixture);
    if (u.pathname.endsWith("/pairings")) {
      if (u.searchParams.get("round") !== "1") return json({ active: [], deleted: [] });
      return json(
        u.searchParams.get("pairingType") === "TeamPairing"
          ? round1TeamPairingFixture
          : round1PairingFixture,
      );
    }
    return json(eventFixture);
  });

const rejectingFetch = (): BcpFetch =>
  vi.fn<BcpFetch>(async () => {
    throw new TypeError("network down");
  });

const ELO: EloSnapshot = {
  generatedAt: "2026-10-17T03:41:57.124Z",
  source: "Stat Check test table",
  players: {
    "ethan davis": 1600,
    "benjamin feehan": 1500,
    "steven rota": 1450,
  },
  misses: [],
};

/**
 * Workers KV as a Map, with the get/put surface the code uses. `failPuts` refuses that many of the
 * next writes the way KV answers a second write to one key inside a second (429).
 */
const fakeDb = (seed: Record<string, string> = {}) => {
  const rows = new Map<string, string>(Object.entries(seed));
  const state = { failReads: false, failWrites: false, failPuts: 0, refused: 0, writes: 0 };
  const db: WdcKv = {
    async get(key: string) {
      if (state.failReads) throw new Error("KV down");
      return rows.get(key) ?? null;
    },
    async put(key: string, value: string) {
      if (state.failWrites) throw new Error("KV down");
      if (state.failPuts > 0) {
        state.failPuts--;
        state.refused++;
        throw new Error("KV PUT failed: 429 Too Many Requests");
      }
      rows.set(key, value);
      state.writes++;
    },
  };
  return { db, rows, state };
};

/** What the owner's `wrangler kv key put wdc.pin.sha256 <hash>` leaves in KV (README.md). */
const setCoachPin = async (db: WdcKv, pin: string): Promise<void> =>
  db.put(WDC_PIN_KEY, await sha256Hex(pin.trim()));

const coachWith = (patch: Partial<WdcCoachState> = {}): WdcCoachState => ({
  ...emptyCoach(),
  ...patch,
});

const lockEight = (): Array<{ us: string; them: string }> =>
  Array.from({ length: 8 }, (_, i) => ({ us: `Us ${i + 1}`, them: `Them ${i + 1}` }));

beforeEach(() => {
  resetBcpCacheForTests();
});

// --- mergeBoard -----------------------------------------------------------------------

describe("mergeBoard", () => {
  let snap: WdcSnapshotInput;
  beforeEach(async () => {
    snap = await loadBcpSnapshot(EVENT, OUR, fixtureFetch());
  });
  const base = { pinSet: true, stale: false, our: OUR };

  it("keeps BCP's score and the coach's score side by side; the BCP score is never replaced", () => {
    const coach = coachWith({
      rounds: {
        "1": {
          opp: "Mandatory F.U.N.",
          players: {
            "ethan davis": { score: 3, nudge: 0 },
            "steve trimble": { score: 9, nudge: 0 },
          },
        },
      },
    });
    const board = mergeBoard(snap, coach, ELO, base);
    const t1 = board.rounds[0].tables.find((t) => t.t === 1)!;
    expect(t1.bcpScore).toBe(20);
    expect(t1.coachScore).toBe(3);
    const t5 = board.rounds[0].tables.find((t) => t.t === 5)!;
    expect(t5.bcpScore).toBe(13);
    expect(t5.coachScore).toBe(9);
    const t2 = board.rounds[0].tables.find((t) => t.t === 2)!;
    expect(t2.coachScore).toBeNull();
    expect(t2.bcpScore).toBe(18);
  });

  it("carries a coach score on a table BCP has not scored yet", () => {
    const open: WdcSnapshotInput = {
      ...snap,
      rounds: snap.rounds.map((r) => ({
        ...r,
        tables: r.tables.map((t) => (t.t === 3 ? { ...t, bcpScore: null } : t)),
      })),
    };
    const coach = coachWith({
      rounds: { "1": { players: { "bryce bennett": { score: 11, nudge: 0 } } } },
    });
    const t3 = mergeBoard(open, coach, ELO, base).rounds[0].tables.find((t) => t.t === 3)!;
    expect(t3.bcpScore).toBeNull();
    expect(t3.coachScore).toBe(11);
  });

  it("spreads predictions across 0..20 for real Elo gaps (owner 2026-10-17)", () => {
    expect(forecastPoints(1500, 1500)).toBe(10);
    expect(forecastPoints(1600, 1500)).toBe(14);
    expect(forecastPoints(1700, 1500)).toBe(17);
    expect(forecastPoints(1830, 1500)).toBe(19);
    expect(forecastPoints(1500, 1600)).toBe(6);
    expect(forecastPoints(1400, 1727)).toBe(1);
  });

  it("passes the nudge through and the forecast stays within 0..20", () => {
    const coach = coachWith({
      rounds: {
        "1": {
          players: {
            "ethan davis": { score: null, nudge: 3 },
            "steven rota": { score: null, nudge: -6 },
          },
        },
      },
    });
    const board = mergeBoard(snap, coach, ELO, base);
    const t1 = board.rounds[0].tables.find((t) => t.t === 1)!;
    expect(t1.nudge).toBe(3);
    // even Elo is 10 of 20; +3 shifts the forecast to 13
    expect(forecastPoints(1500, 1500, t1.nudge)).toBe(13);
    expect(forecastPoints(1500, 1500, 0)).toBe(10);
    // the full 0..20 range is reachable and the clamp holds at both ends however big the nudge
    expect(forecastPoints(1500, 1500, 10)).toBe(20);
    expect(forecastPoints(1500, 1500, -10)).toBe(0);
    expect(forecastPoints(2400, 1000, 20)).toBe(20);
    expect(forecastPoints(1000, 2400, -20)).toBe(0);
    for (const nudge of [-20, -12, -6, 0, 6, 12, 20]) {
      const f = forecastPoints(1400, 1400, nudge);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(20);
    }
  });

  it("resolves Elo: snapshot beats 1400, an override beats the snapshot, unknown stays 1400 and not known", () => {
    const coach = coachWith({ eloOverrides: { "Ethan Davis": 1777, "benjamin  FEEHAN": 1234 } });
    const board = mergeBoard(snap, coach, ELO, base);
    const ours = Object.fromEntries(board.teams[OUR].players.map((p) => [p.name, p]));
    expect(ours["Ethan Davis"]).toMatchObject({ elo: 1777, eloKnown: true });
    expect(ours["Steven Rota"]).toMatchObject({ elo: 1450, eloKnown: true });
    expect(ours["Bryce Bennett"]).toMatchObject({ elo: 1400, eloKnown: false });
    const theirs = Object.fromEntries(
      board.teams["Mandatory F.U.N."].players.map((p) => [p.name, p]),
    );
    expect(theirs["Benjamin Feehan"]).toMatchObject({ elo: 1234, eloKnown: true });
  });

  it("without overrides the snapshot value is used", () => {
    const board = mergeBoard(snap, emptyCoach(), ELO, base);
    const e = board.teams[OUR].players.find((p) => p.name === "Ethan Davis")!;
    expect(e).toMatchObject({ elo: 1600, eloKnown: true });
  });

  it("takes played, bcpAt, currentRound, pinSet, stale and our from the inputs; names the Elo snapshot", () => {
    const board = mergeBoard(snap, emptyCoach(), ELO, { pinSet: false, stale: true, our: OUR });
    expect(board.played).toEqual(["Mandatory F.U.N."]);
    expect(board.bcpAt).toBe(snap.bcpAt);
    expect(board.currentRound).toBe(1);
    expect(board.pinSet).toBe(false);
    expect(board.stale).toBe(true);
    expect(board.our).toBe(OUR);
    expect(board.eloSource).toContain("2026-10-17T03:41:57.124Z");
    expect(board.eloSource).toContain("Stat Check test table");
    expect(board.event.id).toBe(EVENT);
  });

  it("exposes eight coach locks as the next round with fromBcp false and t = lock order", () => {
    const coach = coachWith({
      pairing: { opp: "Calamity Inc.", locks: lockEight() },
      rounds: { "2": { opp: "Calamity Inc.", players: { "us 4": { score: 12, nudge: 2 } } } },
    });
    const board = mergeBoard(snap, coach, ELO, base);
    expect(board.rounds.map((r) => [r.n, r.fromBcp])).toEqual([
      [1, true],
      [2, false],
    ]);
    const r2 = board.rounds[1];
    expect(r2.opp).toBe("Calamity Inc.");
    expect(r2.tables.map((t) => t.t)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r2.tables[0]).toMatchObject({ us: "Us 1", them: "Them 1", bcpScore: null });
    expect(r2.tables[3]).toMatchObject({ coachScore: 12, nudge: 2 });
    expect(board.currentRound).toBe(2);
  });

  it("does not invent a round from fewer than eight locks", () => {
    const coach = coachWith({ pairing: { opp: "Calamity Inc.", locks: lockEight().slice(0, 7) } });
    expect(mergeBoard(snap, coach, ELO, base).rounds.map((r) => r.n)).toEqual([1]);
  });

  it("lets the BCP round win once BCP has published it", () => {
    const withR2: WdcSnapshotInput = {
      ...snap,
      played: [...snap.played, "Calamity Inc."],
      rounds: [
        ...snap.rounds,
        {
          n: 2,
          opp: "Calamity Inc.",
          fromBcp: true,
          tables: [
            { t: 31, us: "Real Us", them: "Real Them", bcpScore: null, coachScore: null, nudge: 0 },
          ],
        },
      ],
    };
    const coach = coachWith({ pairing: { opp: "Calamity Inc.", locks: lockEight() } });
    const board = mergeBoard(withR2, coach, ELO, base);
    expect(board.rounds.map((r) => [r.n, r.fromBcp])).toEqual([
      [1, true],
      [2, true],
    ]);
    expect(board.rounds[1].tables).toHaveLength(1);
    expect(board.rounds[1].tables[0].us).toBe("Real Us");
  });

  it("does not turn stale locks into a later round once BCP has played that opponent", () => {
    // round 1 published against Mandatory F.U.N.; the coach's old locks still name them
    const coach = coachWith({ pairing: { opp: "Mandatory F.U.N.", locks: lockEight() } });
    expect(mergeBoard(snap, coach, ELO, base).rounds.map((r) => r.n)).toEqual([1]);
  });

  it("never invents a round beyond the event's round count", () => {
    const last: WdcSnapshotInput = { ...snap, event: { ...snap.event, rounds: 1 } };
    const coach = coachWith({ pairing: { opp: "Calamity Inc.", locks: lockEight() } });
    expect(mergeBoard(last, coach, ELO, base).rounds.map((r) => r.n)).toEqual([1]);
  });
});

// --- parseCoachState ------------------------------------------------------------------

describe("parseCoachState", () => {
  const good = (): WdcCoachState => ({
    rounds: {
      "1": {
        opp: "Mandatory F.U.N.",
        players: {
          "ethan davis": { score: 14, nudge: -2 },
          "steven rota": { score: null, nudge: 0 },
        },
      },
    },
    pairing: { opp: "Calamity Inc.", locks: lockEight() },
    eloOverrides: { "Ethan Davis": 1650 },
  });

  it("accepts and round-trips a valid document", () => {
    expect(parseCoachState(good())).toEqual(good());
    expect(parseCoachState(emptyCoach())).toEqual(emptyCoach());
  });

  it.each([
    ["score 21", (c: WdcCoachState) => (c.rounds["1"].players["ethan davis"].score = 21)],
    ["score -1", (c: WdcCoachState) => (c.rounds["1"].players["ethan davis"].score = -1)],
    ["score 9.5", (c: WdcCoachState) => (c.rounds["1"].players["ethan davis"].score = 9.5)],
    [
      "score string",
      (c: WdcCoachState) =>
        ((c.rounds["1"].players["ethan davis"] as { score: unknown }).score = "9"),
    ],
    ["nudge 21", (c: WdcCoachState) => (c.rounds["1"].players["ethan davis"].nudge = 21)],
    ["nudge -21", (c: WdcCoachState) => (c.rounds["1"].players["ethan davis"].nudge = -21)],
    ["nudge 1.5", (c: WdcCoachState) => (c.rounds["1"].players["ethan davis"].nudge = 1.5)],
    ["round key 0", (c: WdcCoachState) => (c.rounds["0"] = { players: {} })],
    ["round key text", (c: WdcCoachState) => (c.rounds["abc"] = { players: {} })],
    [
      "player key not normalized",
      (c: WdcCoachState) => (c.rounds["1"].players["Ethan Davis"] = { score: 1, nudge: 0 }),
    ],
    [
      "empty player key",
      (c: WdcCoachState) => (c.rounds["1"].players[""] = { score: 1, nudge: 0 }),
    ],
    [
      "legacy table-keyed round",
      (c: WdcCoachState) =>
        (c.rounds["2"] = { tables: { "1": { score: 1, nudge: 0 } } } as unknown as WdcCoachRound),
    ],
    [
      "legacy tables beside players",
      (c: WdcCoachState) => ((c.rounds["1"] as unknown as Record<string, unknown>).tables = {}),
    ],
    ["opp not a string", (c: WdcCoachState) => ((c.rounds["1"] as { opp: unknown }).opp = 3)],
    ["opp over 120 characters", (c: WdcCoachState) => (c.rounds["1"].opp = "x".repeat(121))],
    ["nine locks", (c: WdcCoachState) => c.pairing.locks.push({ us: "a", them: "b" })],
    [
      "lock without them",
      (c: WdcCoachState) => ((c.pairing.locks[0] as { them: unknown }).them = 4),
    ],
    ["override 99", (c: WdcCoachState) => (c.eloOverrides["Ethan Davis"] = 99)],
    ["override 3001", (c: WdcCoachState) => (c.eloOverrides["Ethan Davis"] = 3001)],
    ["override NaN", (c: WdcCoachState) => (c.eloOverrides["Ethan Davis"] = Number.NaN)],
  ])("rejects %s", (_label, mutate) => {
    const c = good();
    mutate(c);
    expect(parseCoachState(c)).toBeNull();
  });

  it.each([null, undefined, 4, "x", [], {}, { rounds: {}, pairing: {}, eloOverrides: {} }])(
    "rejects a non-document: %j",
    (v) => {
      expect(parseCoachState(v)).toBeNull();
    },
  );

  it("drops unknown fields instead of storing them", () => {
    const c = { ...good(), extra: "x" } as unknown;
    expect(parseCoachState(c)).toEqual(good());
  });

  const rounds = (n: number, tablesPer = 1) =>
    Object.fromEntries(
      Array.from({ length: n }, (_, r) => [
        String(r + 1),
        {
          players: Object.fromEntries(
            Array.from({ length: tablesPer }, (_, t) => [`p${t + 1}`, { score: null, nudge: 0 }]),
          ),
        },
      ]),
    );
  const overrides = (n: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`Player ${i}`, 1500]));

  it("accepts a document right at every cap (12 rounds, 16 player entries, 8 locks, 200 overrides)", () => {
    const c = {
      rounds: rounds(12, 16),
      pairing: { opp: "Calamity Inc.", locks: lockEight() },
      eloOverrides: overrides(200),
    };
    expect(parseCoachState(c)).toEqual(c);
  });

  it.each([
    ["13 rounds", () => ({ ...emptyCoach(), rounds: rounds(13) })],
    ["17 player entries in a round", () => ({ ...emptyCoach(), rounds: rounds(2, 17) })],
    ["201 eloOverrides", () => ({ ...emptyCoach(), eloOverrides: overrides(201) })],
    [
      "9 locks",
      () => ({
        ...emptyCoach(),
        pairing: { opp: "", locks: [...lockEight(), { us: "a", them: "b" }] },
      }),
    ],
  ])("rejects a document over a cap: %s", (_label, make) => {
    expect(parseCoachState(make())).toBeNull();
  });

  it("refuses an oversized document on the counts alone, without reading a round or table", () => {
    let reads = 0;
    const watched = (n: number, value: () => unknown) => {
      const o: Record<string, unknown> = {};
      for (let i = 1; i <= n; i++)
        Object.defineProperty(o, String(i), {
          enumerable: true,
          get: () => {
            reads++;
            return value();
          },
        });
      return o;
    };
    const table = () => ({ score: null, nudge: 0 });
    // 13 rounds: refused before any round value is read
    expect(
      parseCoachState({ ...emptyCoach(), rounds: watched(13, () => ({ players: {} })) }),
    ).toBeNull();
    expect(reads).toBe(0);
    // a round of 17 player entries: refused before any entry is read
    expect(
      parseCoachState({ ...emptyCoach(), rounds: { "1": { players: watched(17, table) } } }),
    ).toBeNull();
    expect(reads).toBe(0);
    // 201 overrides: refused before any round is walked
    expect(
      parseCoachState({
        ...emptyCoach(),
        rounds: watched(1, () => ({ players: {} })),
        eloOverrides: overrides(201),
      }),
    ).toBeNull();
    expect(reads).toBe(0);
  });

  it("refuses the 999 rounds x 999 entries shape from the QA pass", () => {
    const big: Record<string, unknown> = {};
    const players = rounds(1, 999)["1"].players;
    for (let r = 1; r <= 999; r++) big[String(r)] = { players };
    expect(parseCoachState({ ...emptyCoach(), rounds: big })).toBeNull();
  });

  it("does not let a __proto__ override pollute the prototype", () => {
    const parsed = parseCoachState(
      JSON.parse('{"rounds":{},"pairing":{"opp":"","locks":[]},"eloOverrides":{"__proto__":1500}}'),
    );
    expect(parsed).not.toBeNull();
    expect(Object.getPrototypeOf(parsed!.eloOverrides)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)["__proto__"]).toBe(Object.prototype);
  });

  // t-739: forecast weights (docs/HISTORY.md), each 0..2 in steps of 0.25, optional.
  describe("weights", () => {
    it("keeps a document without weights without weights (the page reads the defaults)", () => {
      const parsed = parseCoachState(good());
      expect(parsed).not.toHaveProperty("weights");
    });

    it("round-trips weights on the 0.25 grid, the ends included", () => {
      for (const weights of [
        { faction: 1, form: 0.5, history: 1 },
        { faction: 0, form: 0.75, history: 2 },
        { faction: 1.25, form: 0, history: 0.25 },
      ])
        expect(parseCoachState({ ...good(), weights })).toEqual({ ...good(), weights });
    });

    it("fills a missing weight with its default and drops unknown keys", () => {
      expect(parseCoachState({ ...good(), weights: { form: 0.75 } })?.weights).toEqual({
        faction: 1,
        form: 0.75,
        history: 1,
      });
      expect(parseCoachState({ ...good(), weights: {} })?.weights).toEqual({
        faction: 1,
        form: 0.5,
        history: 1,
      });
      expect(
        parseCoachState({ ...good(), weights: { faction: 1, form: 1, history: 1, extra: 9 } })
          ?.weights,
      ).toEqual({ faction: 1, form: 1, history: 1 });
    });

    it.each([
      ["faction 2.25", { faction: 2.25 }],
      ["form -0.25", { form: -0.25 }],
      ["history 0.3 (off the step)", { history: 0.3 }],
      ["form 1.1 (off the step)", { form: 1.1 }],
      ["faction as a string", { faction: "1" }],
      ["form NaN", { form: Number.NaN }],
      ["history null", { history: null }],
      ["history Infinity", { history: Infinity }],
    ])("rejects weights with %s", (_label, w) => {
      expect(parseCoachState({ ...good(), weights: w })).toBeNull();
    });

    it.each([null, 1, "1x", [1, 0.5, 1]])("rejects weights that are not an object: %j", (w) => {
      expect(parseCoachState({ ...good(), weights: w })).toBeNull();
    });

    it("keeps every other rule with weights present", () => {
      const c = { ...good(), weights: { faction: 1, form: 0.5, history: 1 } };
      c.rounds["1"].players["ethan davis"].score = 21;
      expect(parseCoachState(c)).toBeNull();
    });
  });
});

// --- hashing --------------------------------------------------------------------------

describe("sha256Hex / hexEqual", () => {
  it("matches the SHA-256 test vector and is 64 lowercase hex chars", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await sha256Hex("1234")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("compares equal and unequal strings, including length differences", () => {
    expect(hexEqual("abcd", "abcd")).toBe(true);
    expect(hexEqual("abcd", "abce")).toBe(false);
    expect(hexEqual("abcd", "abc")).toBe(false);
    expect(hexEqual("", "")).toBe(true);
    expect(hexEqual("", "a")).toBe(false);
  });
});

// --- loadBoard (GET /api/board's body) ---------------------------------------------------

describe("loadBoard", () => {
  it("merges live BCP, writes wdc.snapshot.{eventId} with bcpAt and reports stale false", async () => {
    const { db, rows } = fakeDb({
      [wdcStateKey(EVENT)]: JSON.stringify(
        coachWith({ rounds: { "1": { players: { "steve trimble": { score: 9, nudge: 1 } } } } }),
      ),
      [WDC_PIN_KEY]: await sha256Hex("4321"),
    });
    const board = await loadBoard(db, { elo: ELO, kvRetryMs: 0, fetchImpl: fixtureFetch() });
    expect(board.stale).toBe(false);
    expect(board.pinSet).toBe(true);
    expect(board.our).toBe(OUR);
    expect(board.rounds[0].tables.find((t) => t.t === 5)).toMatchObject({
      bcpScore: 13,
      coachScore: 9,
      nudge: 1,
    });
    const stored = JSON.parse(rows.get(wdcSnapshotKey(EVENT))!);
    expect(stored.bcpAt).toBe(board.bcpAt);
    expect(Object.keys(stored.teams)).toHaveLength(17);
  });

  it("uses wdc.event and wdc.team from KV when set", async () => {
    const { db } = fakeDb({ "wdc.event": "OTHER123", "wdc.team": "Calamity Inc." });
    const seen: string[] = [];
    const f: BcpFetch = async (url) => {
      seen.push(url);
      throw new TypeError("down");
    };
    const board = await loadBoard(db, { elo: ELO, kvRetryMs: 0, fetchImpl: f });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((u) => u.includes("OTHER123"))).toBe(true);
    expect(board.event.id).toBe("OTHER123");
    expect(board.our).toBe("Calamity Inc.");
    expect(board.stale).toBe(true);
  });

  it("serves the stored snapshot with stale true when BCP rejects", async () => {
    const { db, rows } = fakeDb();
    const live = await loadBoard(db, { elo: ELO, kvRetryMs: 0, fetchImpl: fixtureFetch() });
    const storedBcpAt = JSON.parse(rows.get(wdcSnapshotKey(EVENT))!).bcpAt;
    resetBcpCacheForTests();
    const board = await loadBoard(db, { elo: ELO, kvRetryMs: 0, fetchImpl: rejectingFetch() });
    expect(board.stale).toBe(true);
    expect(board.bcpAt).toBe(storedBcpAt);
    expect(board.bcpAt).toBe(live.bcpAt);
    expect(board.rounds).toHaveLength(1);
    expect(Object.keys(board.teams)).toHaveLength(17);
  });

  it("also falls back on a non-network BCP failure (HTTP 500)", async () => {
    const { db } = fakeDb();
    await loadBoard(db, { elo: ELO, kvRetryMs: 0, fetchImpl: fixtureFetch() });
    resetBcpCacheForTests();
    const board = await loadBoard(db, {
      elo: ELO,
      kvRetryMs: 0,
      fetchImpl: async () => json({ no: "data" }, 500),
    });
    expect(board.stale).toBe(true);
    expect(board.rounds).toHaveLength(1);
  });

  it("returns a minimal stale state, never throwing, when BCP is down and nothing is stored", async () => {
    const { db } = fakeDb();
    const board = await loadBoard(db, { elo: ELO, kvRetryMs: 0, fetchImpl: rejectingFetch() });
    expect(board.stale).toBe(true);
    expect(board.teams).toEqual({});
    expect(board.rounds).toEqual([]);
    expect(board.bcpAt).toBeNull();
    expect(board.event.id).toBe(EVENT);
    expect(board.pinSet).toBe(false);
    expect(board.coach).toEqual(emptyCoach());
  });

  it("keeps the coach's locks visible in the minimal state", async () => {
    const { db } = fakeDb({
      [wdcStateKey(EVENT)]: JSON.stringify(
        coachWith({ pairing: { opp: "Calamity Inc.", locks: lockEight() } }),
      ),
    });
    const board = await loadBoard(db, { elo: ELO, kvRetryMs: 0, fetchImpl: rejectingFetch() });
    expect(board.stale).toBe(true);
    expect(board.rounds.map((r) => [r.n, r.fromBcp])).toEqual([[1, false]]);
  });

  it("survives a dead KV: still serves BCP, stale false, empty coach", async () => {
    const { db, state } = fakeDb();
    state.failReads = true;
    state.failWrites = true;
    const board = await loadBoard(db, { elo: ELO, kvRetryMs: 0, fetchImpl: fixtureFetch() });
    expect(board.stale).toBe(false);
    expect(board.rounds).toHaveLength(1);
    expect(board.coach).toEqual(emptyCoach());
  });

  it("survives no KV binding at all", async () => {
    const board = await loadBoard(null, { elo: ELO, kvRetryMs: 0, fetchImpl: rejectingFetch() });
    expect(board.stale).toBe(true);
    expect(board.teams).toEqual({});
  });

  it("treats a corrupt stored coach document as empty", async () => {
    const { db } = fakeDb({ [wdcStateKey(EVENT)]: "{not json" });
    const board = await loadBoard(db, { elo: ELO, kvRetryMs: 0, fetchImpl: fixtureFetch() });
    expect(board.coach).toEqual(emptyCoach());
  });

  it("does not rewrite an unchanged snapshot on every poll", async () => {
    const { db, state } = fakeDb();
    await loadBoard(db, { elo: ELO, kvRetryMs: 0, fetchImpl: fixtureFetch() });
    const after1 = state.writes;
    resetBcpCacheForTests();
    await loadBoard(db, { elo: ELO, kvRetryMs: 0, fetchImpl: fixtureFetch() });
    expect(state.writes).toBe(after1);
  });
});

// --- saveCoach (POST /api/save's body) ---------------------------------------------

describe("saveCoach", () => {
  const doc = (): WdcCoachState =>
    coachWith({
      rounds: { "1": { players: { "steve trimble": { score: 9, nudge: 2 } } } },
      pairing: { opp: "Calamity Inc.", locks: lockEight() },
      eloOverrides: { "Steve Trimble": 1500 },
    });
  const deps = () => ({ elo: ELO, kvRetryMs: 0, fetchImpl: fixtureFetch() });

  it("refuses with pin-unset when no PIN row exists, and stores nothing", async () => {
    const { db, rows } = fakeDb();
    const r = await saveCoach(db, { coach: doc(), pin: "1234" }, deps());
    expect(r).toEqual({ ok: false, reason: "pin-unset", message: "Coach PIN not set" });
    expect(rows.has(wdcStateKey(EVENT))).toBe(false);
  });

  describe("Worker secret WDC_PIN_SHA256 fallback", () => {
    const hashOf = (pin: string) => createHash("sha256").update(pin).digest("hex");
    const withSecret = (h: string) => ({ ...deps(), pinHash: h });

    it("saves with the PIN whose hash is in the secret when no PIN row exists", async () => {
      const { db, rows } = fakeDb();
      const r = await saveCoach(
        db,
        { coach: doc(), pin: "warpdust" },
        withSecret(hashOf("warpdust")),
      );
      expect(r.ok).toBe(true);
      expect(JSON.parse(rows.get(wdcStateKey(EVENT))!)).toEqual(doc());
      // the secret is never copied into KV
      expect(rows.has(WDC_PIN_KEY)).toBe(false);
      for (const v of rows.values()) expect(v).not.toContain(hashOf("warpdust"));
    });

    it("reports pinSet from the secret alone", async () => {
      const { db } = fakeDb();
      const board = await loadBoard(db, { ...withSecret(hashOf("warpdust")) });
      expect(board.pinSet).toBe(true);
    });

    it("refuses a wrong PIN against the secret and counts the miss", async () => {
      const { db, rows } = fakeDb();
      const r = await saveCoach(db, { coach: doc(), pin: "nope" }, withSecret(hashOf("warpdust")));
      expect(r).toEqual({ ok: false, reason: "pin", message: "Wrong PIN" });
      expect(rows.has(wdcStateKey(EVENT))).toBe(false);
      expect(JSON.parse(rows.get(WDC_PIN_FAILS_KEY)!).count).toBe(1);
    });

    it("accepts an upper-case or padded hex secret", async () => {
      const { db } = fakeDb();
      const h = ` ${hashOf("warpdust").toUpperCase()}
`;
      const r = await saveCoach(db, { coach: doc(), pin: " warpdust " }, withSecret(h));
      expect(r.ok).toBe(true);
    });

    it("ignores a secret that is not a 64-hex sha256", async () => {
      const { db } = fakeDb();
      for (const bad of ["", "warpdust", "abc", "z".repeat(64), hashOf("warpdust") + "0"]) {
        const r = await saveCoach(db, { coach: doc(), pin: "warpdust" }, withSecret(bad));
        expect(r).toEqual({ ok: false, reason: "pin-unset", message: "Coach PIN not set" });
      }
      expect(secretPinHash({ pinHash: undefined })).toBeNull();
    });

    it("a wdc.pin.sha256 value in KV wins over the secret", async () => {
      const { db } = fakeDb();
      await setCoachPin(db, "1234");
      const viaSecret = await saveCoach(
        db,
        { coach: doc(), pin: "warpdust" },
        withSecret(hashOf("warpdust")),
      );
      expect(viaSecret).toEqual({ ok: false, reason: "pin", message: "Wrong PIN" });
      const viaRow = await saveCoach(
        db,
        { coach: doc(), pin: "1234" },
        withSecret(hashOf("warpdust")),
      );
      expect(viaRow.ok).toBe(true);
    });

    it("a blank PIN is answered Enter the coach PIN and never counted", async () => {
      const { db, rows } = fakeDb();
      const d = withSecret(hashOf("warpdust"));
      for (let i = 0; i < 25; i++) {
        const r = await saveCoach(db, { coach: doc(), pin: i % 2 ? "" : "   " }, d);
        expect(r).toEqual({ ok: false, reason: "pin", message: "Enter the coach PIN" });
      }
      expect(rows.has(WDC_PIN_FAILS_KEY)).toBe(false);
      const ok = await saveCoach(db, { coach: doc(), pin: "warpdust" }, d);
      expect(ok.ok).toBe(true);
    });

    it("accepts the PIN with a capitalised first letter as one attempt", async () => {
      const { db, rows } = fakeDb();
      const r = await saveCoach(
        db,
        { coach: doc(), pin: "Warpdust" },
        withSecret(hashOf("warpdust")),
      );
      expect(r.ok).toBe(true);
      // a correct PIN with no misses on record writes no counter at all
      expect(rows.has(WDC_PIN_FAILS_KEY)).toBe(false);
      const wrong = await saveCoach(
        db,
        { coach: doc(), pin: "Warpdusk" },
        withSecret(hashOf("warpdust")),
      );
      expect(wrong).toEqual({ ok: false, reason: "pin", message: "Wrong PIN" });
      expect(JSON.parse(rows.get(WDC_PIN_FAILS_KEY)!).count).toBe(1);
    });

    it("WDC_PIN_OFF saves with no PIN, never throttles, and reports pinSet false", async () => {
      const { db, rows } = fakeDb({
        [WDC_PIN_FAILS_KEY]: JSON.stringify({ count: 99, windowStart: Date.now() }),
      });
      const d = { ...withSecret(hashOf("warpdust")), pinOff: true };
      const r = await saveCoach(db, { coach: doc(), pin: "" }, d);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.state.pinSet).toBe(false);
      expect(JSON.parse(rows.get(wdcStateKey(EVENT))!)).toEqual(doc());
      expect((await loadBoard(db, d)).pinSet).toBe(false);
    });

    it("the throttle still locks the secret PIN after 10 misses", async () => {
      const { db } = fakeDb();
      const d = withSecret(hashOf("warpdust"));
      for (let i = 0; i < 10; i++) await saveCoach(db, { coach: doc(), pin: `x${i}` }, d);
      const r = await saveCoach(db, { coach: doc(), pin: "warpdust" }, d);
      expect(r).toEqual({ ok: false, reason: "unavailable", message: "Too many tries" });
    });
  });

  it("refuses a wrong PIN and stores nothing", async () => {
    const { db, rows } = fakeDb();
    await setCoachPin(db, "1234");
    const r = await saveCoach(db, { coach: doc(), pin: "9999" }, deps());
    expect(r).toEqual({ ok: false, reason: "pin", message: "Wrong PIN" });
    expect(rows.has(wdcStateKey(EVENT))).toBe(false);
  });

  it("saves with the right PIN, returns the merged board, and the document round-trips", async () => {
    const { db, rows } = fakeDb();
    await setCoachPin(db, "1234");
    const r = await saveCoach(db, { coach: doc(), pin: "1234" }, deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.coach).toEqual(doc());
    expect(r.state.pinSet).toBe(true);
    expect(r.state.rounds[0].tables.find((t) => t.t === 5)).toMatchObject({
      coachScore: 9,
      nudge: 2,
    });
    expect(r.state.rounds.map((x) => [x.n, x.fromBcp])).toEqual([
      [1, true],
      [2, false],
    ]);
    expect(r.state.teams[OUR].players.find((p) => p.name === "Steve Trimble")).toMatchObject({
      elo: 1500,
    });
    expect(JSON.parse(rows.get(wdcStateKey(EVENT))!)).toEqual(doc());
    // a later read sees what was saved
    resetBcpCacheForTests();
    const again = await loadBoard(db, { elo: ELO, kvRetryMs: 0, fetchImpl: fixtureFetch() });
    expect(again.coach).toEqual(doc());
  });

  it("answers from the stored snapshot of any age without calling BCP (t-742)", async () => {
    const { db, rows } = fakeDb();
    await setCoachPin(db, "1234");
    await loadBoard(db, { elo: ELO, kvRetryMs: 0, fetchImpl: fixtureFetch() });
    resetBcpCacheForTests();
    const t0 = Date.now();
    vi.useFakeTimers();
    try {
      // [age, stale]: a healthy board rewrites the snapshot at least every 15 minutes, so only a
      // snapshot past WDC_SNAPSHOT_STALE_MS reports stale
      for (const [age, stale] of [
        [0, false],
        [10 * 60_000, false],
        [WDC_SNAPSHOT_STALE_MS - 1000, false],
        [WDC_SNAPSHOT_STALE_MS, true],
        [3 * 60 * 60_000, true],
      ] as const) {
        vi.setSystemTime(t0 + age);
        const f = fixtureFetch();
        const coach = coachWith({
          rounds: { "1": { players: { "steve trimble": { score: 9, nudge: age ? 1 : 0 } } } },
        });
        const r = await saveCoach(db, { coach, pin: "1234" }, { elo: ELO, kvRetryMs: 0, fetchImpl: f });
        expect(r.ok, String(age)).toBe(true);
        expect(f, String(age)).not.toHaveBeenCalled();
        expect(JSON.parse(rows.get(wdcStateKey(EVENT))!), String(age)).toEqual(coach);
        if (r.ok) {
          expect(r.state.stale, String(age)).toBe(stale);
          expect(r.state.rounds.length, String(age)).toBeGreaterThan(0);
          expect(r.state.coach, String(age)).toEqual(coach);
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("a BCP that never answers cannot stall a save once a snapshot is stored", async () => {
    const { db, rows } = fakeDb();
    await setCoachPin(db, "1234");
    await loadBoard(db, { elo: ELO, kvRetryMs: 0, fetchImpl: fixtureFetch() });
    resetBcpCacheForTests();
    const hung = vi.fn<BcpFetch>(() => new Promise<Response>(() => {}));
    const r = await saveCoach(db, { coach: doc(), pin: "1234" }, { elo: ELO, kvRetryMs: 0, fetchImpl: hung });
    expect(r.ok).toBe(true);
    expect(hung).not.toHaveBeenCalled();
    expect(JSON.parse(rows.get(wdcStateKey(EVENT))!)).toEqual(doc());
  });

  it("with no snapshot stored, writes the document first, then calls BCP for the reply", async () => {
    const { db, rows } = fakeDb();
    await setCoachPin(db, "1234");
    const storedAtFirstCall: boolean[] = [];
    const inner = fixtureFetch();
    const f = vi.fn<BcpFetch>(async (url, init) => {
      storedAtFirstCall.push(rows.has(wdcStateKey(EVENT)));
      return inner(url, init);
    });
    const r = await saveCoach(db, { coach: doc(), pin: "1234" }, { elo: ELO, kvRetryMs: 0, fetchImpl: f });
    expect(r.ok).toBe(true);
    expect(f).toHaveBeenCalled();
    expect(storedAtFirstCall[0]).toBe(true);
    if (r.ok) {
      expect(r.state.stale).toBe(false);
      expect(r.state.rounds[0].tables.find((t) => t.t === 5)).toMatchObject({ coachScore: 9 });
    }
    // the live read was remembered for the next save
    expect(rows.has(wdcSnapshotKey(EVENT))).toBe(true);
  });

  it("still saves when BCP is down and nothing is stored (minimal board, stale true)", async () => {
    const { db, rows } = fakeDb();
    await setCoachPin(db, "1234");
    const r = await saveCoach(
      db,
      { coach: doc(), pin: "1234" },
      { elo: ELO, kvRetryMs: 0, fetchImpl: rejectingFetch() },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state.stale).toBe(true);
      expect(r.state.coach).toEqual(doc());
    }
    expect(JSON.parse(rows.get(wdcStateKey(EVENT))!)).toEqual(doc());
  });

  it("a refused PIN never calls BCP and writes no document", async () => {
    const { db, rows } = fakeDb();
    await setCoachPin(db, "1234");
    const f = fixtureFetch();
    const r = await saveCoach(db, { coach: doc(), pin: "9999" }, { elo: ELO, kvRetryMs: 0, fetchImpl: f });
    expect(r).toEqual({ ok: false, reason: "pin", message: "Wrong PIN" });
    expect(f).not.toHaveBeenCalled();
    expect(rows.has(wdcStateKey(EVENT))).toBe(false);
  });

  it.each([
    [
      "score 25",
      () => ({
        ...doc(),
        rounds: { "1": { players: { "ethan davis": { score: 25, nudge: 0 } } } },
      }),
    ],
    [
      "nudge 21",
      () => ({
        ...doc(),
        rounds: { "1": { players: { "ethan davis": { score: 5, nudge: 21 } } } },
      }),
    ],
    ["override 5000", () => ({ ...doc(), eloOverrides: { A: 5000 } })],
    ["not an object", () => "nope" as unknown as WdcCoachState],
  ])("rejects an invalid document (%s) before storing anything", async (_l, make) => {
    const { db, rows } = fakeDb();
    await setCoachPin(db, "1234");
    const r = await saveCoach(db, { coach: make(), pin: "1234" }, deps());
    expect(r).toMatchObject({ ok: false, reason: "invalid" });
    expect(rows.has(wdcStateKey(EVENT))).toBe(false);
  });

  it("stores the forecast weights with the document and returns them on the board (t-739)", async () => {
    const { db, rows } = fakeDb();
    await setCoachPin(db, "1234");
    const coach = { ...doc(), weights: { faction: 1, form: 0.75, history: 1 } };
    const r = await saveCoach(db, { coach, pin: "1234" }, deps());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.coach.weights).toEqual({ faction: 1, form: 0.75, history: 1 });
    expect(JSON.parse(rows.get(wdcStateKey(EVENT))!).weights).toEqual({
      faction: 1,
      form: 0.75,
      history: 1,
    });
    const board = await loadBoard(db, deps());
    expect(board.coach.weights).toEqual({ faction: 1, form: 0.75, history: 1 });
    // off the 0.25 grid: refused, the stored weights stay
    const bad = await saveCoach(
      db,
      { coach: { ...doc(), weights: { faction: 1, form: 0.6, history: 1 } }, pin: "1234" },
      deps(),
    );
    expect(bad).toMatchObject({ ok: false, reason: "invalid" });
    expect(JSON.parse(rows.get(wdcStateKey(EVENT))!).weights.form).toBe(0.75);
  });

  it("trims the PIN before comparing, as the tablet does", async () => {
    const { db } = fakeDb();
    await setCoachPin(db, "1234");
    expect((await saveCoach(db, { coach: doc(), pin: "1234\n" }, deps())).ok).toBe(true);
    expect((await saveCoach(db, { coach: doc(), pin: "  1234 " }, deps())).ok).toBe(true);
  });

  it("matches a KV PIN hash written with a trailing newline or in upper case", async () => {
    const { db } = fakeDb({ [WDC_PIN_KEY]: `${(await sha256Hex("1234")).toUpperCase()}\n` });
    expect((await saveCoach(db, { coach: doc(), pin: "1234" }, deps())).ok).toBe(true);
    expect((await loadBoard(db, deps())).pinSet).toBe(true);
  });

  it("refuses an oversized document as invalid before touching KV", async () => {
    const { db, state } = fakeDb();
    state.failReads = true;
    state.failWrites = true;
    const big = coachWith({
      rounds: Object.fromEntries(
        Array.from({ length: 13 }, (_, i) => [String(i + 1), { players: {} }]),
      ),
    });
    expect(await saveCoach(db, { coach: big, pin: "1234" }, deps())).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects a non-string PIN as invalid", async () => {
    const { db } = fakeDb();
    await setCoachPin(db, "1234");
    expect(await saveCoach(db, { coach: doc(), pin: 1234 }, deps())).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("reports unavailable on any KV failure", async () => {
    const reads = fakeDb();
    await setCoachPin(reads.db, "1234");
    reads.state.failReads = true;
    expect(await saveCoach(reads.db, { coach: doc(), pin: "1234" }, deps())).toMatchObject({
      ok: false,
      reason: "unavailable",
    });

    const writes = fakeDb();
    await setCoachPin(writes.db, "1234");
    writes.state.failWrites = true;
    expect(await saveCoach(writes.db, { coach: doc(), pin: "1234" }, deps())).toMatchObject({
      ok: false,
      reason: "unavailable",
    });

    expect(await saveCoach(null, { coach: doc(), pin: "1234" }, deps())).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
  });

  it("stores only the SHA-256 of the PIN: 64 hex chars, never the PIN", async () => {
    const { db, rows } = fakeDb();
    await setCoachPin(db, "s3cret-PIN");
    const stored = rows.get(WDC_PIN_KEY)!;
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).toBe(await sha256Hex("s3cret-PIN"));
    expect([...rows.values()].some((v) => v.includes("s3cret-PIN"))).toBe(false);
    // and a saved document never carries it either
    await saveCoach(
      db,
      { coach: emptyCoach(), pin: "s3cret-PIN" },
      { elo: ELO, kvRetryMs: 0, fetchImpl: fixtureFetch() },
    );
    expect([...rows.values()].some((v) => v.includes("s3cret-PIN"))).toBe(false);
  });
});

// --- PIN brute-force throttle ---------------------------------------------------------

describe("saveCoach PIN throttle", () => {
  const deps = () => ({ elo: ELO, kvRetryMs: 0, fetchImpl: fixtureFetch() });
  const doc = (): WdcCoachState =>
    coachWith({ rounds: { "1": { players: { "steve trimble": { score: 9, nudge: 2 } } } } });
  const T0 = Date.parse("2026-10-16T12:00:00Z");
  const wrong = async (db: WdcKv, n: number): Promise<void> => {
    for (let i = 0; i < n; i++)
      await saveCoach(db, { coach: emptyCoach(), pin: `bad${i}` }, deps());
  };
  const counter = (rows: Map<string, string>): { count: number; windowStart: number } =>
    JSON.parse(rows.get(WDC_PIN_FAILS_KEY)!);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers Wrong PIN for the first 10 misses, then locks", async () => {
    const { db } = fakeDb();
    await setCoachPin(db, "1234");
    for (let i = 0; i < 10; i++) {
      const r = await saveCoach(db, { coach: emptyCoach(), pin: "9999" }, deps());
      expect(r).toEqual({ ok: false, reason: "pin", message: "Wrong PIN" });
    }
    expect(await saveCoach(db, { coach: emptyCoach(), pin: "9999" }, deps())).toEqual({
      ok: false,
      reason: "unavailable",
      message: "Too many tries",
    });
  });

  it("refuses the correct PIN inside the window and stores nothing", async () => {
    const { db, rows } = fakeDb();
    await setCoachPin(db, "1234");
    await wrong(db, 10);
    vi.setSystemTime(T0 + 9 * 60_000);
    const r = await saveCoach(db, { coach: emptyCoach(), pin: "1234" }, deps());
    expect(r).toEqual({ ok: false, reason: "unavailable", message: "Too many tries" });
    expect(rows.has(wdcStateKey(EVENT))).toBe(false);
    // locked requests do not extend the window
    expect(counter(rows).count).toBe(10);
  });

  it("lets the correct PIN through once the window has expired", async () => {
    const { db, rows } = fakeDb();
    await setCoachPin(db, "1234");
    await wrong(db, 10);
    vi.setSystemTime(T0 + 10 * 60_000);
    const r = await saveCoach(db, { coach: emptyCoach(), pin: "1234" }, deps());
    expect(r.ok).toBe(true);
    expect(rows.has(wdcStateKey(EVENT))).toBe(true);
    // the expired counter is dead already: nothing to clear, so it is not rewritten
    expect(counter(rows)).toEqual({ count: 10, windowStart: T0 });
  });

  it("restarts the count after the window expires, on a wrong PIN too", async () => {
    const { db, rows } = fakeDb();
    await setCoachPin(db, "1234");
    await wrong(db, 10);
    vi.setSystemTime(T0 + 11 * 60_000);
    const r = await saveCoach(db, { coach: emptyCoach(), pin: "9999" }, deps());
    expect(r).toMatchObject({ ok: false, reason: "pin" });
    expect(counter(rows)).toEqual({ count: 1, windowStart: T0 + 11 * 60_000 });
  });

  it("resets the counter on success, so 10 more wrong tries are needed", async () => {
    const { db, rows } = fakeDb();
    await setCoachPin(db, "1234");
    await wrong(db, 9);
    expect(counter(rows).count).toBe(9);
    expect((await saveCoach(db, { coach: emptyCoach(), pin: "1234" }, deps())).ok).toBe(true);
    expect(counter(rows).count).toBe(0);
    for (let i = 0; i < 10; i++)
      expect(await saveCoach(db, { coach: emptyCoach(), pin: "9999" }, deps())).toMatchObject({
        reason: "pin",
      });
    expect(counter(rows).count).toBe(10);
    expect(await saveCoach(db, { coach: emptyCoach(), pin: "1234" }, deps())).toMatchObject({
      reason: "unavailable",
      message: "Too many tries",
    });
  });

  it("keeps the window anchored at the first miss rather than sliding with each miss", async () => {
    const { db, rows } = fakeDb();
    await setCoachPin(db, "1234");
    await saveCoach(db, { coach: emptyCoach(), pin: "9999" }, deps());
    vi.setSystemTime(T0 + 5 * 60_000);
    await saveCoach(db, { coach: emptyCoach(), pin: "9999" }, deps());
    expect(counter(rows)).toEqual({ count: 2, windowStart: T0 });
  });

  it("never stores the PIN or its hash in the counter", async () => {
    const { db, rows } = fakeDb();
    await setCoachPin(db, "s3cret-PIN");
    await saveCoach(db, { coach: emptyCoach(), pin: "guess-ONE" }, deps());
    const raw = rows.get(WDC_PIN_FAILS_KEY)!;
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["count", "windowStart"]);
    expect(raw).not.toContain("guess-ONE");
    expect(raw).not.toContain("s3cret-PIN");
    expect(raw).not.toContain(await sha256Hex("guess-ONE"));
    expect(raw).not.toContain(await sha256Hex("s3cret-PIN"));
  });

  it("runs after the document check and the storage check, before the PIN", async () => {
    const { db } = fakeDb({
      [WDC_PIN_FAILS_KEY]: JSON.stringify({ count: 10, windowStart: T0 }),
    });
    // locked, but a bad document is still reported as invalid and a missing KV as unavailable
    expect(await saveCoach(db, { coach: "nope", pin: "1234" }, deps())).toMatchObject({
      reason: "invalid",
    });
    expect(await saveCoach(null, { coach: emptyCoach(), pin: "1234" }, deps())).toMatchObject({
      reason: "unavailable",
      message: "Board storage is not available",
    });
    // locked wins over pin-unset (no PIN row exists here)
    expect(await saveCoach(db, { coach: emptyCoach(), pin: "1234" }, deps())).toMatchObject({
      reason: "unavailable",
      message: "Too many tries",
    });
  });

  it("treats a corrupt counter as none", async () => {
    const { db, rows } = fakeDb();
    await setCoachPin(db, "1234");
    rows.set(WDC_PIN_FAILS_KEY, "{not json");
    expect((await saveCoach(db, { coach: emptyCoach(), pin: "1234" }, deps())).ok).toBe(true);
    // and a miss on a corrupt row starts a fresh window at count 1
    rows.set(WDC_PIN_FAILS_KEY, "{not json");
    vi.setSystemTime(T0 + 1000);
    await saveCoach(db, { coach: emptyCoach(), pin: "9999" }, deps());
    expect(counter(rows)).toEqual({ count: 1, windowStart: T0 + 1000 });
  });

  // KV has no atomic increment (state.server.ts, "BEST EFFORT"): requests that race all read the
  // same count. These two pin what that means, so a change to the throttle is a visible choice.
  it("a parallel burst is best effort: each racer is compared and answered Wrong PIN, the count still moves", async () => {
    const { db, rows } = fakeDb();
    await setCoachPin(db, "1234");
    const replies = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        saveCoach(db, { coach: emptyCoach(), pin: `bad${i}` }, deps()),
      ),
    );
    expect(replies.every((r) => !r.ok && r.reason === "pin")).toBe(true);
    // undercounted, never lost: the window is open and at least one miss is on record
    expect(counter(rows).count).toBeGreaterThanOrEqual(1);
    expect(counter(rows).windowStart).toBe(T0);
    const raw = rows.get(WDC_PIN_FAILS_KEY)!;
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["count", "windowStart"]);
    expect(raw).not.toContain("1234");
    expect(raw).not.toContain("bad");
    expect(raw).not.toContain(await sha256Hex("1234"));
  });

  it("sequential misses after a burst still lock, correct PIN included", async () => {
    const { db, rows } = fakeDb();
    await setCoachPin(db, "1234");
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        saveCoach(db, { coach: emptyCoach(), pin: `bad${i}` }, deps()),
      ),
    );
    await wrong(db, 10);
    expect(await saveCoach(db, { coach: doc(), pin: "1234" }, deps())).toEqual({
      ok: false,
      reason: "unavailable",
      message: "Too many tries",
    });
    expect(rows.has(wdcStateKey(EVENT))).toBe(false);
  });

  it("writes nothing for a locked request", async () => {
    const { db, rows, state } = fakeDb();
    await setCoachPin(db, "1234");
    await wrong(db, 10);
    const before = { writes: state.writes, raw: rows.get(WDC_PIN_FAILS_KEY) };
    await saveCoach(db, { coach: emptyCoach(), pin: "9999" }, deps());
    await saveCoach(db, { coach: emptyCoach(), pin: "1234" }, deps());
    expect({ writes: state.writes, raw: rows.get(WDC_PIN_FAILS_KEY) }).toEqual(before);
  });

  it("deleting wdc.pin.fails2 lifts a lockout early (wrangler kv key delete), then the correct PIN saves", async () => {
    const { db, rows } = fakeDb();
    await setCoachPin(db, "1234");
    await wrong(db, 10);
    expect(await saveCoach(db, { coach: doc(), pin: "1234" }, deps())).toMatchObject({
      message: "Too many tries",
    });
    vi.setSystemTime(T0 + 60_000);
    rows.delete(WDC_PIN_FAILS_KEY);
    const r = await saveCoach(db, { coach: doc(), pin: "1234" }, deps());
    expect(r.ok).toBe(true);
    expect(JSON.parse(rows.get(wdcStateKey(EVENT))!)).toEqual(doc());
    expect(rows.has(WDC_PIN_FAILS_KEY)).toBe(false);
  });

  it("the coach's own saves never touch the counter", async () => {
    const { db, rows } = fakeDb();
    await setCoachPin(db, "1234");
    for (let i = 0; i < 15; i++)
      expect((await saveCoach(db, { coach: doc(), pin: "1234" }, deps())).ok).toBe(true);
    expect(rows.has(WDC_PIN_FAILS_KEY)).toBe(false);
  });
});

// --- KV write limits ------------------------------------------------------------------
//
// KV refuses a second write to one key inside about a second. Coach writes retry past that
// (WDC_KV_WRITE_TRIES); the PIN counter fails closed; the snapshot write is skipped, never awaited.

describe("KV write limits", () => {
  const deps = () => ({ elo: ELO, kvRetryMs: 0, fetchImpl: fixtureFetch() });
  const doc = (): WdcCoachState =>
    coachWith({ rounds: { "1": { players: { "steve trimble": { score: 9, nudge: 2 } } } } });

  it("retries a coach write KV refuses once, and saves", async () => {
    const { db, rows, state } = fakeDb();
    await setCoachPin(db, "1234");
    await loadBoard(db, deps()); // snapshot stored, so the save's only write is the document
    state.failPuts = 1;
    const r = await saveCoach(db, { coach: doc(), pin: "1234" }, deps());
    expect(r.ok).toBe(true);
    expect(state.refused).toBe(1);
    expect(JSON.parse(rows.get(wdcStateKey(EVENT))!)).toEqual(doc());
  });

  it("gives up after WDC_KV_WRITE_TRIES refusals with a storage error", async () => {
    const { db, rows, state } = fakeDb();
    await setCoachPin(db, "1234");
    await loadBoard(db, deps());
    state.failPuts = WDC_KV_WRITE_TRIES;
    expect(await saveCoach(db, { coach: doc(), pin: "1234" }, deps())).toEqual({
      ok: false,
      reason: "unavailable",
      message: "Save failed: storage error",
    });
    expect(state.refused).toBe(WDC_KV_WRITE_TRIES);
    expect(rows.has(wdcStateKey(EVENT))).toBe(false);
  });

  it("waits WDC_KV_RETRY_MS between tries by default", async () => {
    const { db, state } = fakeDb();
    await setCoachPin(db, "1234");
    await loadBoard(db, deps());
    // only setTimeout (the retry wait) and Date are fake; setImmediate stays real to let the
    // PIN hash (Web Crypto, off the timer queue) finish before the clock moves
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      state.failPuts = 1;
      const pending = saveCoach(
        db,
        { coach: doc(), pin: "1234" },
        { elo: ELO, fetchImpl: fixtureFetch() },
      );
      while (state.refused === 0) await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(WDC_KV_RETRY_MS - 1);
      expect(state.writes).toBe(2); // the PIN and the snapshot, not yet the document
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).ok).toBe(true);
      expect(state.writes).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers Too many tries, not Wrong PIN, when a miss cannot be counted", async () => {
    const { db, rows, state } = fakeDb();
    await setCoachPin(db, "1234");
    state.failPuts = WDC_KV_WRITE_TRIES;
    expect(await saveCoach(db, { coach: doc(), pin: "9999" }, deps())).toEqual({
      ok: false,
      reason: "unavailable",
      message: "Too many tries",
    });
    expect(rows.has(WDC_PIN_FAILS_KEY)).toBe(false);
    expect(rows.has(wdcStateKey(EVENT))).toBe(false);
  });

  it("still saves when clearing earlier misses is refused (they expire with their window)", async () => {
    const { db, rows, state } = fakeDb();
    await setCoachPin(db, "1234");
    await saveCoach(db, { coach: doc(), pin: "9999" }, deps());
    await loadBoard(db, deps());
    state.failPuts = WDC_KV_WRITE_TRIES; // every try of the counter reset
    const r = await saveCoach(db, { coach: doc(), pin: "1234" }, deps());
    expect(r.ok).toBe(true);
    expect(JSON.parse(rows.get(WDC_PIN_FAILS_KEY)!).count).toBe(1);
    expect(JSON.parse(rows.get(wdcStateKey(EVENT))!)).toEqual(doc());
  });

  it("skips a refused snapshot write without retrying, and still serves the live board", async () => {
    const { db, rows, state } = fakeDb();
    state.failPuts = 1;
    const board = await loadBoard(db, deps());
    expect(board.stale).toBe(false);
    expect(state.refused).toBe(1);
    expect(rows.has(wdcSnapshotKey(EVENT))).toBe(false);
  });

  it("rewrites an unchanged snapshot only once it is 15 minutes old", async () => {
    const T = Date.parse("2026-10-16T12:00:00Z");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T);
      const { db, rows, state } = fakeDb();
      await loadBoard(db, deps());
      expect(state.writes).toBe(1);
      for (const minutes of [1, 5, 14]) {
        vi.setSystemTime(T + minutes * 60_000);
        resetBcpCacheForTests();
        await loadBoard(db, deps());
      }
      expect(state.writes).toBe(1);
      vi.setSystemTime(T + WDC_SNAPSHOT_REFRESH_MS);
      resetBcpCacheForTests();
      await loadBoard(db, deps());
      expect(state.writes).toBe(2);
      expect(JSON.parse(rows.get(wdcSnapshotKey(EVENT))!).bcpAt).toBe(
        new Date(T + WDC_SNAPSHOT_REFRESH_MS).toISOString(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("rewrites the snapshot at once when BCP's content changes", async () => {
    const { db, rows, state } = fakeDb();
    await loadBoard(db, deps());
    expect(state.writes).toBe(1);
    resetBcpCacheForTests();
    const changed = vi.fn<BcpFetch>(async (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/teamPlayers")) return json(standingsFixture);
      if (u.pathname.endsWith("/pairings")) return json({ active: [], deleted: [] });
      return json(eventFixture);
    });
    await loadBoard(db, { elo: ELO, kvRetryMs: 0, fetchImpl: changed });
    expect(state.writes).toBe(2);
    expect(JSON.parse(rows.get(wdcSnapshotKey(EVENT))!).rounds).toEqual([]);
  });
});

// --- the browser client --------------------------------------------------------------

describe("api/wdc.functions.ts client", () => {
  it("keeps the two names and shapes the page codes against, and has no em-dash", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      fileURLToPath(new URL("../api/wdc.functions.ts", import.meta.url)),
      "utf8",
    );
    expect(src).toContain("export async function getWdcBoard(): Promise<WdcBoardState>");
    expect(src).toContain(
      "export async function saveWdcCoachState({ data }: { data: WdcSaveInput }): Promise<WdcSaveResult>",
    );
    expect(src).toContain("export type WdcSaveInput");
    expect(src).toContain("export type WdcSaveResult");
    expect(src).not.toContain(String.fromCharCode(0x2014));
  });
});

// --- coach entries keyed by our player, end to end (C3, C6, t-736) ----------------------
//
// Every case runs the real flow: loadBoard and saveCoach against the fake KV, BCP served from the real
// TEO-8 fixtures (round 2 is our posted match against Rule Lawyerz - Malicious Compliance), and every
// tablet edit built by the page's own withTable / withPairing (components/wdc/model.ts).

describe("player-keyed coach entries through saveCoach and loadBoard", () => {
  const OPP = "Rule Lawyerz - Malicious Compliance";
  const OUR_MATCH = "cIqaHFPfFIKW"; // our round 2 team pairing in round2-teampairing.json
  const PIN = "1234";

  type Game = { points: number | null } & Record<string, unknown>;
  type PairingRow = {
    table: number;
    isDone: boolean;
    teamPairingId: string;
    player1Game: Game | null;
    player2Game: Game | null;
  } & Record<string, unknown>;
  type TeamRow = { id: string; teamPlayer2: { name: string } | null } & Record<string, unknown>;
  type Round2 = { pairing: { active: PairingRow[] }; team: { active: TeamRow[] } };

  /**
   * BCP's round 2 from the real fixtures. Our eight games are open (no result) except the tables in
   * `scored`, which keep their real result; `seated` keeps only those of our tables (a partial post);
   * `opp` renames the team we were paired against.
   */
  const round2 = (o: { seated?: number[]; scored?: number[]; opp?: string } = {}): Round2 => {
    const pairing = structuredClone(round2PairingFixture) as unknown as Round2["pairing"];
    pairing.active = pairing.active
      .filter((r) => r.teamPairingId !== OUR_MATCH || !o.seated || o.seated.includes(r.table))
      .map((r) =>
        r.teamPairingId !== OUR_MATCH || o.scored?.includes(r.table)
          ? r
          : {
              ...r,
              isDone: false,
              player1Game: r.player1Game && { ...r.player1Game, points: 0 },
              player2Game: r.player2Game && { ...r.player2Game, points: 0 },
            },
      );
    const team = structuredClone(round2TeamPairingFixture) as unknown as Round2["team"];
    if (o.opp)
      for (const t of team.active)
        if (t.id === OUR_MATCH && t.teamPlayer2) t.teamPlayer2 = { ...t.teamPlayer2, name: o.opp };
    return { pairing, team };
  };

  /** BCP with round 1 posted and round 2 as given (null: not posted yet). */
  const bcp = (r2: Round2 | null) =>
    vi.fn<BcpFetch>(async (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/teamPlayers")) return json(standingsFixture);
      if (u.pathname.endsWith("/pairings")) {
        const team = u.searchParams.get("pairingType") === "TeamPairing";
        const n = u.searchParams.get("round");
        if (n === "1") return json(team ? round1TeamPairingFixture : round1PairingFixture);
        if (n === "2" && r2) return json(team ? r2.team : r2.pairing);
        return json({ active: [], deleted: [] });
      }
      return json(eventFixture);
    });

  /** A tablet's poll: a fresh BCP read (the 60 s cache cleared first). */
  const read = async (db: WdcKv, r2: Round2 | null): Promise<WdcBoardState> => {
    resetBcpCacheForTests();
    return loadBoard(db, { elo: ELO, kvRetryMs: 0, fetchImpl: bcp(r2) });
  };
  /** A tablet's save with the right PIN; returns the reply board. */
  const save = async (
    db: WdcKv,
    coach: WdcCoachState,
    r2: Round2 | null,
  ): Promise<WdcBoardState> => {
    resetBcpCacheForTests();
    const r = await saveCoach(db, { coach, pin: PIN }, { elo: ELO, kvRetryMs: 0, fetchImpl: bcp(r2) });
    if (!r.ok) throw new Error(`save refused: ${r.message}`);
    return r.state;
  };

  const roundOf = (b: WdcBoardState, n: number): WdcRound => b.rounds.find((r) => r.n === n)!;
  const tableOf = (b: WdcBoardState, n: number, us: string): WdcTable =>
    roundOf(b, n).tables.find((t) => t.us === us)!;
  /** What a tap on `us`'s table card sends: the page's own withTable. */
  const tap = (b: WdcBoardState, us: string, patch: { score?: number | null; nudge?: number }) =>
    withTable(b, roundOf(b, 2), tableOf(b, 2, us), patch);
  /** Round 2 as shown: [table, our player, coach score, nudge] for each table carrying an entry. */
  const shown = (b: WdcBoardState): Array<[number, string, number | null, number]> =>
    roundOf(b, 2)
      .tables.filter((t) => t.coachScore !== null || t.nudge !== 0)
      .map((t) => [t.t, t.us, t.coachScore, t.nudge]);
  const storedRound2 = (rows: Map<string, string>) =>
    parseCoachState(JSON.parse(rows.get(wdcStateKey(EVENT))!))!.rounds["2"];

  // Our eight in roster order, against their real BCP opponents. Lock order is not BCP's table
  // order: Ethan Davis is lock 1 but BCP table 4, Steve Trimble lock 5 but table 1, Steven Rota
  // lock 2 but table 7, Dustin Hammond lock 8 but table 3.
  const LOCKS = [
    ["Ethan Davis", "patrick powers"],
    ["Steven Rota", "Sam Powers"],
    ["Bryce Bennett", "Jesse Egner"],
    ["Nicholas Fromme", "Dakota Jones"],
    ["Steve Trimble", "Caleb Pierson"],
    ["Daniel Kelley", "Donovan Garrett"],
    ["Hogan Franklin", "Johann Ingason"],
    ["Dustin Hammond", "Jared Street"],
  ].map(([us, them]) => ({ us, them }));

  // After BCP posts round 2, the two entries made on the lock tables, on their players' BCP games.
  const POSTED: Array<[number, string, number | null, number]> = [
    [1, "Steve Trimble", null, 2],
    [4, "Ethan Davis", 17, 0],
  ];

  /**
   * (a), first half: BCP has round 1 only; the coach locks round 2, sets tables, then enters 17 on
   * Ethan Davis's lock table and +2 on Steve Trimble's. Returns the tablet's last pre-post board.
   */
  const lockAndScore = async () => {
    const { db, rows } = fakeDb();
    await setCoachPin(db, PIN);
    let page = await read(db, null);
    expect(page.rounds.map((r) => r.n)).toEqual([1]);
    page = await save(db, withPairing(page, { opp: OPP, locks: LOCKS }), null);
    expect(roundOf(page, 2)).toMatchObject({ fromBcp: false, opp: OPP });
    expect(tableOf(page, 2, "Ethan Davis").t).toBe(1);
    expect(tableOf(page, 2, "Steve Trimble").t).toBe(5);
    page = await save(db, tap(page, "Ethan Davis", { score: 17 }), null);
    page = await save(db, tap(page, "Steve Trimble", { nudge: 2 }), null);
    expect(shown(page)).toEqual([
      [1, "Ethan Davis", 17, 0],
      [5, "Steve Trimble", null, 2],
    ]);
    expect(storedRound2(rows)).toEqual({
      opp: OPP,
      players: {
        "ethan davis": { score: 17, nudge: 0 },
        "steve trimble": { score: null, nudge: 2 },
      },
    });
    return { db, rows, prePost: page };
  };

  it("teamKey, which the page shares, is bcpTeamKey", () => {
    const names = [
      ...standingsFixture.active.map((t) => t.name),
      "Mandatory F.U.N",
      "  Rule  Lawyerz - Malicious Compliance. ",
      "WARP dust crusaders!?",
    ];
    for (const n of names) expect(teamKey(n)).toBe(bcpTeamKey(n));
  });

  it("(a) lock-table entries land on the same players' BCP games only, and a posted result wins", async () => {
    const { db } = await lockAndScore();
    const posted = await read(db, round2());
    expect(roundOf(posted, 2)).toMatchObject({ fromBcp: true, opp: OPP });
    expect(tableOf(posted, 2, "Ethan Davis").t).toBe(4);
    expect(tableOf(posted, 2, "Steve Trimble").t).toBe(1);
    expect(shown(posted)).toEqual(POSTED);

    // BCP posts Ethan Davis's game (20-0): BCP's score wins over the coach's 17
    const done = await read(db, round2({ scored: [4] }));
    const t4 = tableOf(done, 2, "Ethan Davis");
    expect(t4).toMatchObject({ t: 4, bcpScore: 20, coachScore: 17 });
    expect(tableScore(t4)).toBe(20);
    expect(
      roundOf(done, 2)
        .tables.filter((t) => t.bcpScore !== null)
        .map((t) => t.t),
    ).toEqual([4]);
    expect(shown(done)).toEqual(POSTED);
  });

  it("(b) a stale tablet saving its unchanged pre-post document twice in a row moves nothing", async () => {
    const { db, prePost } = await lockAndScore();
    await read(db, round2()); // BCP posts; another tablet reads it
    const first = await save(db, prePost.coach, round2());
    const second = await save(db, prePost.coach, round2());
    expect(shown(first)).toEqual(POSTED);
    expect(shown(second)).toEqual(POSTED);
    expect(shown(await read(db, round2()))).toEqual(POSTED);
  });

  it("(c) a stale tablet's edit on another player's lock table lands on that player's BCP game only", async () => {
    const { db, prePost } = await lockAndScore();
    await read(db, round2());
    expect(tableOf(prePost, 2, "Dustin Hammond").t).toBe(8); // still the lock-built round on that tablet
    await save(db, tap(prePost, "Dustin Hammond", { score: 12 }), round2());
    expect(shown(await read(db, round2()))).toEqual([
      [1, "Steve Trimble", null, 2],
      [3, "Dustin Hammond", 12, 0],
      [4, "Ethan Davis", 17, 0],
    ]);
  });

  it("(d) a save whose stored snapshot is older than the page's view moves nothing", async () => {
    const { db, rows } = await lockAndScore();
    const before = rows.get(wdcSnapshotKey(EVENT))!; // read before BCP posted, under a minute old
    expect(JSON.parse(before).rounds).toHaveLength(1);
    const page = await read(db, round2()); // the tablet sees the posted round
    expect(shown(page)).toEqual(POSTED);
    rows.set(wdcSnapshotKey(EVENT), before); // the save path still reads the older copy
    const reply = await save(db, tap(page, "Steven Rota", { score: 9 }), round2());
    // the reply is merged against the older snapshot (lock-built), every entry on its player
    expect(roundOf(reply, 2).fromBcp).toBe(false);
    expect(shown(reply)).toEqual([
      [1, "Ethan Davis", 17, 0],
      [2, "Steven Rota", 9, 0],
      [5, "Steve Trimble", null, 2],
    ]);
    expect(shown(await read(db, round2()))).toEqual([
      [1, "Steve Trimble", null, 2],
      [4, "Ethan Davis", 17, 0],
      [7, "Steven Rota", 9, 0],
    ]);
  });

  it("(e) a partial BCP post loses no entry: unseated players' entries wait for their games", async () => {
    const { db, rows } = await lockAndScore();
    // four of our eight games posted; Ethan Davis (4) and Steve Trimble (1) are not seated yet
    const partial = round2({ seated: [2, 3, 5, 6] });
    const page = await read(db, partial);
    expect(roundOf(page, 2).tables.map((t) => t.t)).toEqual([2, 3, 5, 6]);
    expect(shown(page)).toEqual([]);
    await save(db, tap(page, "Dustin Hammond", { score: 15 }), partial);
    expect(storedRound2(rows)).toEqual({
      opp: OPP,
      players: {
        "ethan davis": { score: 17, nudge: 0 },
        "steve trimble": { score: null, nudge: 2 },
        "dustin hammond": { score: 15, nudge: 0 },
      },
    });
    expect(shown(await read(db, round2()))).toEqual([
      [1, "Steve Trimble", null, 2],
      [3, "Dustin Hammond", 15, 0],
      [4, "Ethan Davis", 17, 0],
    ]);
  });

  it("(f) entries written against another opponent show nowhere and stay stored", async () => {
    const { db, rows } = await lockAndScore();
    const kept = storedRound2(rows);
    const other = await read(db, round2({ opp: "Calamity Inc." }));
    expect(roundOf(other, 2)).toMatchObject({ fromBcp: true, opp: "Calamity Inc." });
    expect(roundOf(other, 2).tables).toHaveLength(8);
    expect(shown(other)).toEqual([]);
    expect(other.coach.rounds["2"]).toEqual(kept);
    expect(storedRound2(rows)).toEqual(kept);
    // they reappear if BCP corrects the pairing to the team they were written against
    expect(shown(await read(db, round2()))).toEqual(POSTED);
  });

  it("(f) the first entry against the shown opponent starts that round afresh", async () => {
    const { db } = await lockAndScore();
    const other = await read(db, round2({ opp: "Calamity Inc." }));
    const doc = tap(other, "Dustin Hammond", { score: 11 });
    expect(doc.rounds["2"]).toEqual({
      opp: "Calamity Inc.",
      players: { "dustin hammond": { score: 11, nudge: 0 } },
    });
    const reply = await save(db, doc, round2({ opp: "Calamity Inc." }));
    expect(shown(reply)).toEqual([[3, "Dustin Hammond", 11, 0]]);
  });

  it("stores exactly what the page sent: no table keys, no server markers", async () => {
    const { rows } = await lockAndScore();
    const raw = JSON.parse(rows.get(wdcStateKey(EVENT))!);
    expect(Object.keys(raw.rounds["2"]).sort()).toEqual(["opp", "players"]);
  });
});

// --- save input shape and size (t-733 F7) -----------------------------------------------

describe("save input check", () => {
  const deps = () => ({ elo: ELO, kvRetryMs: 0, fetchImpl: fixtureFetch() });

  it.each([
    ["null", null],
    ["a string", "nope"],
    ["an array", []],
    ["no coach", { pin: "1234" }],
    ["a null coach", { coach: null, pin: "1234" }],
    ["a numeric pin", { coach: emptyCoach(), pin: 1234 }],
  ])("answers invalid for %s, without throwing", (_l, input) => {
    expect(checkSaveInput(input)).toEqual({
      ok: false,
      reason: "invalid",
      message: "Invalid coach document",
    });
  });

  it("refuses an input over 64 KB and passes a normal one through", () => {
    const big = { coach: { ...emptyCoach(), junk: "x".repeat(70 * 1024) }, pin: "1234" };
    expect(JSON.stringify(big).length).toBeGreaterThan(WDC_SAVE_MAX_BYTES);
    expect(checkSaveInput(big)).toEqual({
      ok: false,
      reason: "invalid",
      message: "Coach document too large",
    });
    const fine = { coach: emptyCoach(), pin: "1234" };
    expect(checkSaveInput(fine)).toEqual({ ok: true, input: fine });
  });

  it("saveCoach(db, null) and a 70 KB input answer invalid and touch nothing", async () => {
    const { db, state } = fakeDb();
    state.failReads = true;
    state.failWrites = true;
    await expect(saveCoach(db, null, deps())).resolves.toMatchObject({
      ok: false,
      reason: "invalid",
    });
    const big = { coach: { ...emptyCoach(), junk: "x".repeat(70 * 1024) }, pin: "1234" };
    await expect(saveCoach(db, big, deps())).resolves.toEqual({
      ok: false,
      reason: "invalid",
      message: "Coach document too large",
    });
    expect(state.writes).toBe(0);
  });
});

// --- our team through BCP's key (t-733 F8) ----------------------------------------------

describe("configured team name", () => {
  it("resolves wdc.team in lower case to our standings row", async () => {
    const { db } = fakeDb({ "wdc.team": "warp dust crusaders" });
    const board = await loadBoard(db, { elo: ELO, kvRetryMs: 0, fetchImpl: fixtureFetch() });
    expect(board.our).toBe(OUR);
    expect(board.teams[board.our].players.length).toBeGreaterThan(0);
    expect(board.rounds[0].opp).toBe("Mandatory F.U.N.");
  });

  it("mergeBoard maps a case and punctuation variant onto the snapshot spelling", async () => {
    const snap = await loadBcpSnapshot(EVENT, OUR, fixtureFetch());
    const board = mergeBoard(snap, emptyCoach(), ELO, {
      pinSet: true,
      stale: false,
      our: "WARP  dust crusaders.",
    });
    expect(board.our).toBe(OUR);
    // an unknown name is passed through unchanged
    expect(
      mergeBoard(snap, emptyCoach(), ELO, { pinSet: true, stale: false, our: "Nobody" }).our,
    ).toBe("Nobody");
  });
});
