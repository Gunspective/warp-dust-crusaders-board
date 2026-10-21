// Contract C5: Elo name matching for the coach board.
import { describe, expect, it } from "vitest";
import realSnapshot from "./elo-snapshot.json";
import round1PairingFixture from "./fixtures/round1-pairing.json";
import { lookupElo, lookupEloIn, normalizeName, WDC_UNKNOWN_ELO, type EloSnapshot } from "./elo";

const fixture: EloSnapshot = {
  generatedAt: "2026-10-16T00:00:00.000Z",
  source: "fixture",
  misses: [],
  players: {
    "dustin hammond": 1671.2,
    "samuel young": 1441.8,
    "elyn fritzwaters": 1500,
    "maria garcia": 1620,
    "mario garcia": 1380,
    "jesse lee": 1555,
    "andrew lee": 1490,
    "alex lee": 1510,
    "a lee": 1593.2,
    "butters s": 1450,
    "dylan 40k": 1475,
  },
};

describe("normalizeName", () => {
  it("lowercases, trims, collapses whitespace and strips punctuation", () => {
    expect(normalizeName("  Dustin   HAMMOND ")).toBe("dustin hammond");
    expect(normalizeName("A.  Lee")).toBe("a lee");
    expect(normalizeName("Elyn Fritz-Waters")).toBe("elyn fritzwaters");
    expect(normalizeName("Pat O'Brien Jr.")).toBe("pat obrien jr");
    expect(normalizeName("dylan 40k")).toBe("dylan 40k");
    expect(normalizeName("")).toBe("");
  });

  it("folds accents so BCP and Stat Check spellings meet", () => {
    expect(normalizeName("José Muñoz")).toBe("jose munoz");
  });
});

describe("lookupElo (C5)", () => {
  it("matches exactly after normalization", () => {
    expect(lookupElo("Dustin  Hammond", fixture)).toEqual({
      elo: 1671.2,
      known: true,
      matchedAs: "dustin hammond",
    });
    expect(lookupElo("Elyn Fritz-Waters", fixture)).toEqual({
      elo: 1500,
      known: true,
      matchedAs: "elyn fritzwaters",
    });
  });

  it("matches same last name + first-name prefix (3+ letters) when exactly one table name fits", () => {
    // "Sam Young" is not in the table, "Samuel Young" is the only Young whose first name starts with "sam".
    expect(lookupElo("Sam Young", fixture)).toEqual({
      elo: 1441.8,
      known: true,
      matchedAs: "samuel young",
    });
  });

  it("prefers the exact match over the initial + last-name fallback", () => {
    const snap = { players: { "sam young": 1600, "samuel young": 1441.8 } };
    expect(lookupElo("Sam Young", snap)).toEqual({
      elo: 1600,
      known: true,
      matchedAs: "sam young",
    });
  });

  it("stays unknown when the prefix rule fits more than one table name", () => {
    const snap = {
      players: {
        "maria garcia": 1620,
        "mariana garcia": 1380,
        "alex lee": 1510,
        "alexander lee": 1490,
      },
    };
    expect(lookupElo("Mari Garcia", snap)).toEqual({ elo: WDC_UNKNOWN_ELO, known: false });
    expect(lookupElo("Alexa Lee", snap).known).toBe(false); // "alex" and "alexander" both fit
  });

  it("does not match a different person who only shares the first initial and last name", () => {
    const cases: Array<[string, string]> = [
      ["Aaron Greene", "ash greene"],
      ["Landan Ross", "lloyd ross"],
      ["Robert Matthews", "richard matthews"],
      ["Sam Powers", "shaun powers"],
      ["Vinny Cabral", "vinicius cabral"],
      ["CJ Smith", "christian smith"],
    ];
    for (const [query, other] of cases) {
      expect(lookupEloIn(query, { [other]: 1450 })).toEqual({ elo: WDC_UNKNOWN_ELO, known: false });
      expect(lookupEloIn(other, { [normalizeName(query)]: 1450 })).toEqual({
        elo: WDC_UNKNOWN_ELO,
        known: false,
      });
    }
  });

  it("matches a prefix first name in either direction, but never across last names", () => {
    expect(lookupEloIn("Samuel Young", { "sam young": 1500 }).matchedAs).toBe("sam young");
    expect(lookupEloIn("Sam Young", { "samuel yung": 1500 }).known).toBe(false);
    expect(lookupEloIn("Al Young", { "alan young": 1500 }).known).toBe(false); // 2 letters is not enough
  });

  it("skips the fuzzy fallback for a name the generator dropped, but an exact hit still wins", () => {
    const players = { "samuel young": 1441.8, "sam young": 1600 };
    expect(lookupEloIn("Sam Young", { "samuel young": 1441.8 })).toMatchObject({ known: true });
    expect(
      lookupEloIn("Sam Young", { "samuel young": 1441.8 }, [
        { name: "Sam Young", reason: "claimed" },
      ]),
    ).toEqual({
      elo: WDC_UNKNOWN_ELO,
      known: false,
    });
    expect(lookupEloIn("sam  young", { "samuel young": 1441.8 }, ["Sam Young"]).known).toBe(false);
    expect(lookupEloIn("Sam Young", players, ["Sam Young"])).toEqual({
      elo: 1600,
      known: true,
      matchedAs: "sam young",
    });
  });

  it("stays unknown when nothing fits", () => {
    expect(lookupElo("Totally Unknown", fixture)).toEqual({ elo: WDC_UNKNOWN_ELO, known: false });
    expect(lookupElo("", fixture)).toEqual({ elo: WDC_UNKNOWN_ELO, known: false });
  });

  it("never matches BCP display handles like 'Butters s', 'A. Lee' and 'dylan 40k', even when the table carries the same string", () => {
    for (const handle of ["Butters s", "A. Lee", "A.  Lee", "dylan 40k"]) {
      expect(lookupElo(handle, fixture)).toEqual({ elo: WDC_UNKNOWN_ELO, known: false });
    }
    // and an initial-only table name is not a candidate for a full-name query
    expect(lookupEloIn("Alan Lee", { "a lee": 1593.2 })).toEqual({
      elo: WDC_UNKNOWN_ELO,
      known: false,
    });
    // the same handles stay unknown against a table that has no such strings at all
    const bare = { players: { "jesse lee": 1555, "andrew lee": 1490 } };
    for (const handle of ["Butters s", "A. Lee", "dylan 40k"]) {
      expect(lookupElo(handle, bare).known).toBe(false);
    }
  });
});

// The repo ships this snapshot empty; these checks run once scripts/statcheck-elo.mjs has written it.
const REAL_ELO = realSnapshot as EloSnapshot;
describe.skipIf(Object.keys(REAL_ELO.players).length === 0)(
  "elo-snapshot.json (generated by scripts/statcheck-elo.mjs)",
  () => {
  const snap = REAL_ELO;
  const matched = Object.keys(snap.players).length;

  it("has the documented shape", () => {
    expect(typeof snap.generatedAt).toBe("string");
    expect(Number.isNaN(Date.parse(snap.generatedAt))).toBe(false);
    expect(snap.source.length).toBeGreaterThan(20);
    expect(Array.isArray(snap.misses)).toBe(true);
    for (const [key, elo] of Object.entries(snap.players)) {
      expect(key).toBe(normalizeName(key));
      expect(typeof elo).toBe("number");
      expect(elo).toBeGreaterThan(800);
      expect(elo).toBeLessThan(3000);
    }
  });

  it("beats the June export (105 of 136) or names every miss", () => {
    const named = snap.misses.every((m) => m.name.trim() !== "" && m.reason.trim() !== "");
    expect(named).toBe(true);
    expect(matched > 105 || (snap.misses.length > 0 && named)).toBe(true);
    // Every one of the 136 roster names is either matched or named as a miss.
    expect(matched + snap.misses.length).toBe(136);
    for (const m of snap.misses) expect(normalizeName(m.name) in snap.players).toBe(false);
  });

  it("keeps the handle names unmatched and a known player matched", () => {
    for (const handle of ["Butters s", "A. Lee", "dylan 40k"]) {
      expect(lookupElo(handle, snap).known).toBe(false);
      expect(snap.misses.some((m) => normalizeName(m.name) === normalizeName(handle))).toBe(true);
    }
    expect(lookupElo("Dustin Hammond", snap).known).toBe(true);
  });

  it("never resurrects a dropped match: Sam Young stays unknown, Samuel Young keeps his rating", () => {
    expect(lookupElo("Sam Young", snap)).toEqual({ elo: WDC_UNKNOWN_ELO, known: false });
    expect(lookupElo("Samuel Young", snap)).toEqual({
      elo: 1441.8,
      known: true,
      matchedAs: "samuel young",
    });
  });

  it("resolves the 136 roster names to unknown exactly where the snapshot lists a miss", () => {
    // The roster is the one the generator reads: every player in the round 1 pairings.
    const roster = new Set<string>();
    type Seat = { user?: { firstName?: string; lastName?: string } } | undefined;
    const rows = (
      round1PairingFixture as unknown as { active: Array<{ player1?: Seat; player2?: Seat }> }
    ).active;
    for (const row of rows)
      for (const seat of [row.player1, row.player2]) {
        const u = seat?.user;
        if (u) roster.add(`${u.firstName ?? ""} ${u.lastName ?? ""}`.replace(/\s+/g, " ").trim());
      }
    expect(roster.size).toBe(136);

    const unknown = [...roster]
      .filter((n) => !lookupElo(n, snap).known)
      .map(normalizeName)
      .sort();
    const missed = snap.misses.map((m) => normalizeName(m.name)).sort();
    expect(missed).toHaveLength(33);
    expect(unknown).toEqual(missed);
  });
});
