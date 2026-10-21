// docs/HISTORY.md: the BCP player history edges on the board forecast (form, 11th edition vs this
// army), the forecast weights, and the zero-weight identity with the Elo plus faction forecast.
import { describe, expect, it, vi } from "vitest";

// The repo ships matchup-snapshot.json empty; these tests run on the synthetic fixture instead.
vi.mock("./matchup-snapshot.json", () => import("./fixtures/matchups-sample.json"));
import { MATCHUPS, pairForecast } from "../../components/wdc/model";
import { makeBoard, makeHistory, OUR } from "../../components/wdc/fixture";
import {
  armyTerm,
  DEFAULT_WEIGHTS,
  EMPTY_HISTORY,
  FORM_PRIOR_GAMES,
  formEdge,
  HISTORY_PRIOR_GAMES,
  historyEdge,
  historyNote,
  isWeight,
  logit,
  resolveWeights,
  shrunkShare,
  type HistoryRecord,
  type PlayerHistoryEntry,
  type PlayerHistorySnapshot,
} from "./history";
import { factionEdge } from "./matchups";
import { forecastPoints, type WdcPlayer } from "./types";

const r = (w: number, l: number, d = 0): HistoryRecord => ({ g: w + l + d, w, d, l });

const entry = (name: string, over: Partial<PlayerHistoryEntry> = {}): PlayerHistoryEntry => ({
  name,
  year: r(0, 0),
  ed11: r(0, 0),
  vs: {},
  as: {},
  ...over,
});

const snap = (...entries: Array<[string, PlayerHistoryEntry]>): PlayerHistorySnapshot => ({
  ...EMPTY_HISTORY,
  players: Object.fromEntries(entries),
});

const player = (name: string, faction: string, dispo = "", elo = 1500): WdcPlayer => ({
  name,
  team: "",
  faction,
  dispo,
  elo,
  eloKnown: true,
  list: null,
});

describe("shrink math", () => {
  it("shrinks (w + d/2) / g toward 0.5 by K pseudo-games", () => {
    expect(FORM_PRIOR_GAMES).toBe(20);
    expect(HISTORY_PRIOR_GAMES).toBe(10);
    // 5-0 with K = 10: (5 + 5) / 15
    expect(shrunkShare(r(5, 0), 10)).toBeCloseTo(10 / 15, 12);
    // 30-6 with K = 20: (30 + 10) / 56
    expect(shrunkShare(r(30, 6), 20)).toBeCloseTo(40 / 56, 12);
    // draws count half: 1 win, 2 draws, 1 loss is exactly even
    expect(shrunkShare(r(1, 1, 2), 20)).toBe(0.5);
    // a big sample moves further than a small one at the same rate
    expect(shrunkShare(r(80, 20), 20)).toBeGreaterThan(shrunkShare(r(4, 1), 20));
  });

  it("reads no record, no games or an impossible record as the 0.5 prior", () => {
    expect(shrunkShare(undefined, 20)).toBe(0.5);
    expect(shrunkShare(r(0, 0), 20)).toBe(0.5);
    expect(shrunkShare({ g: 3, w: 4, d: 0, l: 0 }, 20)).toBe(0.5);
    expect(shrunkShare({ g: Number.NaN, w: 1, d: 0, l: 0 }, 20)).toBe(0.5);
    expect(logit(0.5)).toBe(0);
  });
});

describe("formEdge", () => {
  const h = snap(
    ["strong", entry("Strong", { ed11: r(30, 6) })],
    ["weak", entry("Weak", { ed11: r(10, 20) })],
  );

  it("is positive for the better 11th edition record, negative the other way, and antisymmetric", () => {
    const e = formEdge(h, "Strong", "Weak");
    expect(e).toBeGreaterThan(0);
    expect(formEdge(h, "Weak", "Strong")).toBeCloseTo(-e, 12);
    expect(e).toBeCloseTo(logit(40 / 56) - logit(20 / 50), 12);
  });

  it("looks players up by normalizeName of the display name", () => {
    expect(formEdge(h, "  STRONG ", "weak.")).toBeCloseTo(formEdge(h, "Strong", "Weak"), 12);
  });

  it("is 0 for two missing players and treats one missing player as the prior", () => {
    expect(formEdge(h, "Nobody", "Also Nobody")).toBe(0);
    expect(formEdge(EMPTY_HISTORY, "Strong", "Weak")).toBe(0);
    expect(formEdge(h, "Nobody", "Weak")).toBeCloseTo(-logit(20 / 50), 12);
  });
});

describe("historyEdge", () => {
  const us = player("Ann Able", "World Eaters", "Purge the Foe");
  const them = player("Ben Baker", "Necrons", "Take and Hold");

  it("prefers the as row (what the player brings) over the overall vs row", () => {
    const h = snap([
      "ann able",
      entry("Ann Able", {
        ed11: r(10, 10),
        vs: { Necrons: r(0, 5) },
        as: { "World Eaters|Purge the Foe": { ...r(6, 4), vs: { Necrons: r(5, 0) } } },
      }),
    ]);
    const e = historyEdge(h, us, them);
    expect(e).toBeCloseTo(logit(10 / 15) - logit(15 / 30), 12);
    expect(e).toBeGreaterThan(0);
    // Another disposition has no as row: the 0-5 vs row is used instead.
    const other = { ...us, dispo: "Linchpin" };
    expect(historyEdge(h, other, them)).toBeCloseTo(logit(5 / 15) - logit(15 / 30), 12);
    expect(historyEdge(h, other, them)).toBeLessThan(0);
  });

  it("falls back to vs when the as row has no games against that army", () => {
    const h = snap([
      "ann able",
      entry("Ann Able", {
        ed11: r(10, 10),
        vs: { Necrons: r(4, 1) },
        as: { "World Eaters|Purge the Foe": { ...r(6, 4), vs: { Orks: r(2, 2) } } },
      }),
    ]);
    expect(historyEdge(h, us, them)).toBeCloseTo(logit(9 / 15) - logit(15 / 30), 12);
  });

  it("matches armies through factionKey, so a BCP suffix still finds the Stat Check row", () => {
    const h = snap([
      "ann able",
      entry("Ann Able", { ed11: r(10, 10), vs: { "Space Marines": r(5, 0) } }),
    ]);
    const marines = player("Cal Cole", "Space Marines (Astartes)");
    expect(historyEdge(h, us, marines)).toBeCloseTo(logit(10 / 15) - logit(15 / 30), 12);
  });

  it("mirrors their player against our army and subtracts it", () => {
    const h = snap(
      ["ann able", entry("Ann Able", { ed11: r(10, 10), vs: { Necrons: r(5, 0) } })],
      ["ben baker", entry("Ben Baker", { ed11: r(8, 2), vs: { "World Eaters": r(4, 0) } })],
    );
    const ours = armyTerm(h, us, "Necrons");
    const theirs = armyTerm(h, them, "World Eaters");
    // Ben is 8-2 overall (p0 13/20) and 4-0 into World Eaters: shrunk toward his own level, so positive
    expect(theirs).toBeCloseTo(logit((4 + 10 * (13 / 20)) / 14) - logit(13 / 20), 12);
    expect(theirs).toBeGreaterThan(0);
    expect(historyEdge(h, us, them)).toBeCloseTo(ours - theirs, 12);
    expect(historyEdge(h, them, us)).toBeCloseTo(theirs - ours, 12);
  });

  it("never reads an unbeaten record into an army as underperformance, nor a winless one as overperformance", () => {
    for (const [w, l] of [
      [27, 3],
      [18, 2],
      [10, 10],
      [3, 12],
      [40, 8],
    ] as const) {
      for (const g of [1, 2, 4, 9]) {
        const h = snap(
          ["ann able", entry("Ann Able", { ed11: r(w, l), vs: { Necrons: r(g, 0) } })],
          ["cal cole", entry("Cal Cole", { ed11: r(w, l), vs: { Necrons: r(0, g) } })],
        );
        expect(armyTerm(h, us, "Necrons")).toBeGreaterThan(0);
        expect(armyTerm(h, { ...us, name: "Cal Cole" }, "Necrons")).toBeLessThan(0);
      }
    }
  });

  it("counts a draw as half a win: a draw-only record reads slightly below a strong player's norm", () => {
    // Ruling 2026-10-18 (final QA): 0W 1D 0L is a 50% result, so for a player whose own 11th share is
    // above 50% it is a small negative term, and for one below 50% a small positive term.
    const h = snap(
      ["ann able", entry("Ann Able", { ed11: r(14, 6), vs: { Necrons: r(0, 0, 1) } })],
      ["cal cole", entry("Cal Cole", { ed11: r(6, 14), vs: { Necrons: r(0, 0, 1) } })],
    );
    const strong = armyTerm(h, us, "Necrons");
    const weak = armyTerm(h, { ...us, name: "Cal Cole" }, "Necrons");
    expect(strong).toBeLessThan(0);
    expect(strong).toBeGreaterThan(-0.06);
    expect(weak).toBeGreaterThan(0);
    expect(weak).toBeLessThan(0.06);
  });

  it("is 0 for a missing player or a missing army row", () => {
    const h = snap(["ann able", entry("Ann Able", { ed11: r(10, 10), vs: { Orks: r(5, 0) } })]);
    expect(historyEdge(h, us, them)).toBe(0); // no Necrons row, Ben not in the snapshot
    expect(historyEdge(EMPTY_HISTORY, us, them)).toBe(0);
    expect(armyTerm(h, player("Nobody Here", "Orks"), "Orks")).toBe(0);
    expect(armyTerm(h, { ...us, faction: "" }, "Orks")).toBeCloseTo(
      logit(10 / 15) - logit(15 / 30),
      12,
    );
    expect(armyTerm(h, us, "")).toBe(0);
  });
});

describe("historyNote", () => {
  it("reads the as row with faction and disposition, then the 11th edition record", () => {
    const h = makeHistory();
    expect(
      historyNote(h, player("Us Player 1", "World Eaters", "Purge the Foe"), "World Eaters"),
    ).toBe(
      "Us Player 1 (World Eaters, Purge the Foe) 5W 0D 0L into World Eaters in 11th; 18W 0D 2L in 11th overall",
    );
    expect(historyNote(h, player("NearA Player 1", "World Eaters"), "World Eaters")).toBe(
      "NearA Player 1 1W 0D 3L into World Eaters in 11th; 2W 0D 10L in 11th overall",
    );
    expect(historyNote(h, player("NearA Player 1", "World Eaters"), "Orks")).toBe(
      "NearA Player 1: 2W 0D 10L in 11th overall",
    );
    expect(historyNote(h, player("Nobody", "Orks"), "Orks")).toBe("");
  });
});

describe("weights", () => {
  it("accepts 0..2 in 0.25 steps only", () => {
    for (const v of [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) expect(isWeight(v)).toBe(true);
    for (const v of [-0.25, 2.25, 0.3, 1.1, Number.NaN, Infinity, "1", null, undefined])
      expect(isWeight(v)).toBe(false);
  });

  it("defaults faction 1, form 0.5, history 1 for each one missing or out of shape", () => {
    expect(DEFAULT_WEIGHTS).toEqual({ faction: 1, form: 0.5, history: 1 });
    expect(resolveWeights(undefined)).toEqual(DEFAULT_WEIGHTS);
    expect(resolveWeights({ form: 0.75 })).toEqual({ faction: 1, form: 0.75, history: 1 });
    expect(resolveWeights({ faction: 3, form: 0.1, history: 0 })).toEqual({
      faction: 1,
      form: 0.5,
      history: 0,
    });
  });
});

describe("pairForecast with the history terms", () => {
  const TODAY = { faction: 1, form: 0, history: 0 };

  it("with weights {faction 1, form 0, history 0} equals the Elo plus faction forecast for every input", () => {
    const history = makeHistory();
    const factions = Object.keys(MATCHUPS.rows);
    // players with and without history, so the zeroed terms are really there to zero
    const names: Array<[string, string]> = [
      ["Us Player 1", "NearA Player 1"],
      ["NearA Player 1", "Us Player 1"],
      ["Nobody One", "Nobody Two"],
    ];
    let checked = 0;
    for (const [a, b] of names)
      for (const fa of [...factions.slice(0, 8), "World Eaters", "Imperium", ""])
        for (const fb of factions.slice(0, 8))
          for (const [ea, eb] of [
            [1500, 1500],
            [1650, 1420],
            [1380, 1720],
          ])
            for (const nudge of [-3, 0, 2]) {
              const us = player(a, fa, "Purge the Foe", ea);
              const them = player(b, fb, "", eb);
              const today = forecastPoints(ea, eb, nudge, factionEdge(MATCHUPS, fa, fb));
              const f = pairForecast(us, them, nudge, { history, weights: TODAY });
              expect(f.points).toBe(today);
              expect(f.noHistory).toBe(today);
              checked++;
            }
    expect(checked).toBe(3 * 11 * 8 * 3 * 3);
  });

  it("with no history snapshot gives today's forecast at any weights", () => {
    const board = makeBoard();
    const us = board.teams[OUR].players[0];
    const them = board.teams["Near A"].players[3];
    const today = forecastPoints(
      us.elo,
      them.elo,
      0,
      factionEdge(MATCHUPS, us.faction, them.faction),
    );
    for (const form of [0, 1, 2])
      for (const hist of [0, 1, 2])
        expect(
          pairForecast(us, them, 0, {
            history: EMPTY_HISTORY,
            weights: { faction: 1, form, history: hist },
          }).points,
        ).toBe(today);
  });

  it("adds the weighted form and history log-odds to the Elo term", () => {
    const history = makeHistory();
    const us = player("Us Player 1", "World Eaters", "Purge the Foe", 1500);
    const them = player("NearA Player 1", "World Eaters", "Take and Hold", 1480);
    const f = pairForecast(us, them, 0, { history, weights: DEFAULT_WEIGHTS });
    expect(f.edges.faction).toBe(0); // a mirror
    expect(f.edges.form).toBeCloseTo(logit(28 / 40) - logit(12 / 32), 12); // ed11 18-2 vs 2-10, K=20
    expect(f.edges.history).toBeCloseTo(
      logit((5 + 10 * (23 / 30)) / 15) -
        logit(23 / 30) -
        (logit((1 + 10 * (7 / 22)) / 14) - logit(7 / 22)),
      12,
    );
    const edge = 0.5 * f.edges.form + 1 * f.edges.history;
    expect(f.points).toBe(forecastPoints(1500, 1480, 0, edge));
    expect(f.points).toBe(16);
    expect(f.noHistory).toBe(11);
    // more form weight, higher forecast for the stronger 11th edition record
    const more = pairForecast(us, them, 0, {
      history,
      weights: { ...DEFAULT_WEIGHTS, form: 0.75 },
    });
    expect(more.points).toBe(17);
  });
});
