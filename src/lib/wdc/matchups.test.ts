// Contract C4 (as built): the Stat Check faction matchup edge on the board forecast.
import { describe, expect, it } from "vitest";
import round1PairingFixture from "./fixtures/round1-pairing.json";
import round2PairingFixture from "./fixtures/round2-pairing.json";
import sampleSnapshot from "./fixtures/matchups-sample.json";
import realSnapshot from "./matchup-snapshot.json";
import {
  factionEdge,
  factionKey,
  factionMatchup,
  MATCHUP_PRIOR_GAMES,
  resolveFaction,
  shrunkWinRate,
  type MatchupSnapshot,
} from "./matchups";
import { expectedShare, forecastPoints, WDC_ELO_SCALE } from "./types";

const REAL = realSnapshot as unknown as MatchupSnapshot;
/** Synthetic rows under the 29 Stat Check faction names (fixtures/matchups-sample.json). */
const SAMPLE = sampleSnapshot as unknown as MatchupSnapshot;

const snap = (rows: MatchupSnapshot["rows"]): MatchupSnapshot => ({
  generatedAt: "2026-10-18T00:00:00.000Z",
  source: "fixture",
  meta: "fixture meta",
  updated: "2026-10-14",
  rows,
});

const bcpFactions = (fixture: unknown): string[] => {
  const rows = (fixture as { active: Array<Record<string, { faction?: string } | null>> }).active;
  const out = new Set<string>();
  for (const r of rows) {
    for (const p of [r.player1, r.player2])
      if (p && typeof p.faction === "string") out.add(p.faction);
  }
  return [...out].sort();
};

describe("factionKey", () => {
  it("folds case, a trailing parenthetical, apostrophes and punctuation", () => {
    expect(factionKey("Space Marines (Astartes)")).toBe("space marines");
    expect(factionKey("T'au Empire")).toBe("tau empire");
    expect(factionKey("Emperor’s Children")).toBe("emperors children");
    expect(factionKey("  Adeptus   CUSTODES ")).toBe("adeptus custodes");
    expect(factionKey("Genestealer Cult")).toBe("genestealer cults");
    expect(factionKey("")).toBe("");
  });

  it("maps every BCP faction in the round 1 and round 2 fixtures to a Stat Check faction, except Imperium", () => {
    const names = [
      ...new Set([...bcpFactions(round1PairingFixture), ...bcpFactions(round2PairingFixture)]),
    ];
    expect(names.length).toBeGreaterThan(20);
    const unknown = names.filter((n) => resolveFaction(SAMPLE, n) == null);
    expect(unknown).toEqual(["Imperium"]);
    expect(resolveFaction(SAMPLE, "Space Marines (Astartes)")).toBe("Space Marines");
    expect(resolveFaction(SAMPLE, "Genestealer Cult")).toBe("Genestealer Cults");
    expect(resolveFaction(SAMPLE, "T'au Empire")).toBe("T'au Empire");
    expect(resolveFaction(SAMPLE, "")).toBeNull();
  });
});

describe("factionEdge", () => {
  it("shrinks the win rate toward 50% with a 20-game prior and returns its log-odds", () => {
    expect(MATCHUP_PRIOR_GAMES).toBe(20);
    expect(shrunkWinRate({ wr: 0.7, games: 50 })).toBeCloseTo((35 + 10) / 70, 12);
    expect(shrunkWinRate({ wr: 1, games: 1 })).toBeCloseTo(11 / 21, 12);
    expect(shrunkWinRate({ wr: 0.5, games: 300 })).toBeCloseTo(0.5, 12);
    // clamped to 0.05..0.95 for a huge lopsided sample
    expect(shrunkWinRate({ wr: 1, games: 100000 })).toBe(0.95);
    expect(shrunkWinRate({ wr: 0, games: 100000 })).toBe(0.05);
    const s = snap({ Orks: { Necrons: { wr: 0.7, games: 50 } } });
    const p = 45 / 70;
    expect(factionEdge(s, "Orks", "Necrons")).toBeCloseTo(Math.log(p / (1 - p)), 12);
  });

  it("uses our row against them, else their row mirrored", () => {
    const s = snap({
      Orks: { Necrons: { wr: 0.7, games: 50 } },
      Necrons: { Orks: { wr: 0.3, games: 50 }, Tyranids: { wr: 0.25, games: 30 } },
    });
    expect(factionMatchup(s, "Orks", "Necrons")).toMatchObject({ us: "Orks", wr: 0.7, games: 50 });
    // only Necrons v Tyranids exists: Tyranids v Necrons reads it as 75% over 30 games
    const m = factionMatchup(s, "Tyranids", "Necrons")!;
    expect(m.wr).toBeCloseTo(0.75, 12);
    expect(m.games).toBe(30);
    expect(m.edge).toBeCloseTo(-factionEdge(s, "Necrons", "Tyranids"), 12);
  });

  it("returns 0 for a mirror, an unknown faction, an empty faction and a missing row", () => {
    const s = snap({ Orks: { Necrons: { wr: 0.7, games: 50 } }, Tyranids: {} });
    expect(factionEdge(s, "Orks", "Orks")).toBe(0);
    expect(factionEdge(SAMPLE, "Adeptus Custodes", "Adeptus Custodes")).toBe(0);
    expect(factionEdge(SAMPLE, "Space Marines (Astartes)", "Space Marines")).toBe(0);
    expect(factionEdge(s, "Imperium", "Orks")).toBe(0);
    expect(factionEdge(SAMPLE, "Imperium", "Adeptus Custodes")).toBe(0);
    expect(factionEdge(s, "", "Orks")).toBe(0);
    expect(factionEdge(s, "Orks", "Tyranids")).toBe(0);
    expect(factionMatchup(s, "Orks", "Tyranids")).toBeNull();
  });

  it("reads the sample snapshot's rows as mirror images of each other", () => {
    const a = factionMatchup(SAMPLE, "Adeptus Custodes", "Adepta Sororitas")!;
    const b = factionMatchup(SAMPLE, "Adepta Sororitas", "Adeptus Custodes")!;
    expect(a.wr + b.wr).toBeCloseTo(1, 4);
    expect(a.games).toBe(b.games);
    expect(a.edge).toBeCloseTo(-b.edge, 3);
  });
});

describe("forecastPoints with a faction edge", () => {
  it("is identical to the Elo-only forecast with edge 0, for every input", () => {
    // The pre-edge implementation, verbatim.
    const before = (usElo: number, themElo: number, nudge = 0) => {
      const raw = Math.round(20 * (1 / (1 + Math.pow(10, (themElo - usElo) / WDC_ELO_SCALE))));
      return Math.max(0, Math.min(20, Math.max(0, Math.min(20, raw)) + nudge));
    };
    for (let us = 1000; us <= 2400; us += 7) {
      for (let them = 1000; them <= 2400; them += 13) {
        for (const nudge of [-20, -3, 0, 2, 20]) {
          expect(forecastPoints(us, them, nudge, 0)).toBe(before(us, them, nudge));
          expect(forecastPoints(us, them, nudge)).toBe(before(us, them, nudge));
        }
      }
    }
    expect(expectedShare(1600, 1500)).toBe(1 / (1 + Math.pow(10, -100 / WDC_ELO_SCALE)));
  });

  it("adds the edge to the Elo log-odds", () => {
    // even Elo: p is the shrunk win rate itself
    const p = 45 / 70;
    const edge = Math.log(p / (1 - p));
    expect(forecastPoints(1500, 1500, 0, edge)).toBe(Math.round(20 * p));
    // a negative edge mirrors a positive one
    expect(forecastPoints(1500, 1500, 0, -edge)).toBe(20 - Math.round(20 * p));
    // the nudge still applies after the edge, and the clamp still holds
    expect(forecastPoints(1500, 1500, 2, edge)).toBe(Math.round(20 * p) + 2);
    expect(forecastPoints(2400, 1000, 20, 3)).toBe(20);
    expect(forecastPoints(1000, 2400, -20, -3)).toBe(0);
  });

  it("moves a 1500 v 1500 forecast by at most 1 point on a 1-game 100% row", () => {
    const s = snap({ Orks: { Necrons: { wr: 1, games: 1 } } });
    const shift = forecastPoints(1500, 1500, 0, factionEdge(s, "Orks", "Necrons")) - 10;
    expect(Math.abs(shift)).toBeLessThanOrEqual(1);
    expect(shift).toBe(0); // 11/21 = 52.4% of 20 is 10.5, which rounds to 10
  });

  it("moves a 1500 v 1500 forecast by 3 points on a 50-game 70% row", () => {
    const s = snap({ Orks: { Necrons: { wr: 0.7, games: 50 } } });
    // shrunk to 45/70 = 64.3%: 12.86 of 20, so 13-7 instead of 10-10
    expect(forecastPoints(1500, 1500, 0, factionEdge(s, "Orks", "Necrons"))).toBe(13);
    expect(forecastPoints(1500, 1500, 0, factionEdge(s, "Necrons", "Orks"))).toBe(7);
  });
});

// The repo ships this snapshot empty; these checks run once scripts/statcheck-matchups.mjs has written it.
describe.skipIf(Object.keys(REAL.rows).length === 0)(
  "matchup-snapshot.json (generated by scripts/statcheck-matchups.mjs)",
  () => {
  it("has the documented shape with rounded numbers", () => {
    expect(REAL.source).toBe(
      "https://public.tableau.com/views/StatCheckThe40kMetaDataDashboard-11thEdition/MatchupMatrix",
    );
    expect(Number.isNaN(Date.parse(REAL.generatedAt))).toBe(false);
    const factions = Object.keys(REAL.rows);
    expect(factions.length).toBeGreaterThan(20);
    for (const p of factions) {
      for (const [o, row] of Object.entries(REAL.rows[p])) {
        expect(o).not.toBe(p);
        expect(row.wr).toBeGreaterThanOrEqual(0);
        expect(row.wr).toBeLessThanOrEqual(1);
        expect(row.games).toBeGreaterThan(0);
        expect(Math.round(row.wr * 10000) / 10000).toBe(row.wr);
      }
    }
  });
});
