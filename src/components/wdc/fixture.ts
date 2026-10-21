// Fixture board for the board render tests: round 1 in progress against "Near A", standings that
// make the opponent shortlist interesting. Not shipped to users; kept beside the components so the
// tests and any future story share one shape.
import type { PlayerHistorySnapshot } from "../../lib/wdc/history";
import type { WdcBoardState, WdcPlayer, WdcTeam } from "../../lib/wdc/types";

const FACTIONS = [
  "World Eaters",
  "Necrons",
  "Space Marines",
  "Aeldari",
  "Orks",
  "Tyranids",
  "Death Guard",
  "Drukhari",
];
const DISPOS = [
  "Purge the Foe",
  "Take and Hold",
  "Hidden Supplies",
  "Linchpin",
  "Scorched Earth",
  "Priority Targets",
  "Burden of Trust",
  "Deploy Servo-skulls",
];

export function makeTeam(
  name: string,
  tag: string,
  opts: { placing: number | null; matchPoints: number; eloBase: number },
): WdcTeam {
  const players: WdcPlayer[] = Array.from({ length: 8 }, (_, i) => ({
    name: `${tag} Player ${i + 1}`,
    team: name,
    faction: FACTIONS[i],
    dispo: DISPOS[i],
    elo: opts.eloBase + i * 20,
    eloKnown: i !== 7,
    list: `${tag.toLowerCase()}list${i + 1}`,
  }));
  return {
    name,
    captain: players[0].name,
    placing: opts.placing,
    matchPoints: opts.matchPoints,
    battlePoints: 0,
    gameWins: 0,
    players,
  };
}

export const OUR = "Warp Dust Crusaders";

export function makeBoard(over: Partial<WdcBoardState> = {}): WdcBoardState {
  const teams: Record<string, WdcTeam> = {};
  for (const t of [
    makeTeam(OUR, "Us", { placing: 4, matchPoints: 2, eloBase: 1500 }),
    makeTeam("Near A", "NearA", { placing: 1, matchPoints: 2, eloBase: 1480 }),
    makeTeam("Played Team", "Played", { placing: 2, matchPoints: 2, eloBase: 1450 }),
    makeTeam("Near B", "NearB", { placing: 5, matchPoints: 3, eloBase: 1520 }),
    makeTeam("Near C", "NearC", { placing: 6, matchPoints: 1, eloBase: 1400 }),
    makeTeam("Far Low", "FarLow", { placing: 16, matchPoints: 0, eloBase: 1350 }),
    makeTeam("Far High", "FarHigh", { placing: 3, matchPoints: 5, eloBase: 1600 }),
  ]) {
    teams[t.name] = t;
  }
  const near = teams["Near A"].players;
  const us = teams[OUR].players;
  const tables = us.map((p, i) => ({
    t: i + 1,
    us: p.name,
    them: near[i].name,
    bcpScore: null,
    coachScore: null,
    nudge: 0,
  }));
  return {
    event: { id: "EVT1", name: "TEO-8 All in.", where: "Hopkinsville KY", rounds: 5, teamSize: 8 },
    our: OUR,
    teams,
    rounds: [{ n: 1, opp: "Near A", fromBcp: true, tables }],
    currentRound: 1,
    played: [],
    coach: { rounds: {}, pairing: { opp: "", locks: [] }, eloOverrides: {} },
    bcpAt: "2026-10-16T18:05:00.000Z",
    stale: false,
    eloSource: "Stat Check snapshot",
    pinSet: true,
    ...over,
  };
}

/**
 * Round 1 posted by BCP against Near A, and round 2 built from the coach's eight locks against
 * Near B (fromBcp false, t = lock order). The locks take our players in reverse roster order, so a
 * lock table number is never that player's roster slot: table 3 is Us Player 6.
 */
export function makeLockBoard(over: Partial<WdcBoardState> = {}): WdcBoardState {
  const base = makeBoard();
  const us = base.teams[OUR].players;
  const them = base.teams["Near B"].players;
  const locks = us.map((p, i) => ({ us: p.name, them: them[i].name })).reverse();
  const tables = locks.map((l, i) => ({
    t: i + 1,
    us: l.us,
    them: l.them,
    bcpScore: null,
    coachScore: null,
    nudge: 0,
  }));
  return {
    ...base,
    rounds: [...base.rounds, { n: 2, opp: "Near B", fromBcp: false, tables }],
    currentRound: 2,
    played: ["Near A"],
    coach: { rounds: {}, pairing: { opp: "Near B", locks }, eloOverrides: {} },
    ...over,
  };
}

/**
 * A small player-history snapshot (docs/HISTORY.md shape) for table 1 of makeBoard: Us Player 1
 * (World Eaters, Purge the Foe) has a strong 11th edition record and a 5-0 World Eaters mirror record as
 * what they bring; NearA Player 1 has a weak year and 1-3 into World Eaters. Every other fixture
 * player is absent, so their forecasts carry no history.
 */
export function makeHistory(): PlayerHistorySnapshot {
  return {
    generatedAt: "2026-10-18T03:00:00.000Z",
    eventId: "EVT1",
    windowStart: "2025-10-18",
    editionStart: "2026-06-26",
    players: {
      "us player 1": {
        name: "Us Player 1",
        year: { g: 36, w: 30, d: 0, l: 6 },
        ed11: { g: 20, w: 18, d: 0, l: 2 },
        vs: { "World Eaters": { g: 6, w: 5, d: 0, l: 1 } },
        as: {
          "World Eaters|Purge the Foe": {
            g: 15,
            w: 10,
            d: 0,
            l: 5,
            vs: { "World Eaters": { g: 5, w: 5, d: 0, l: 0 } },
          },
        },
      },
      "neara player 1": {
        name: "NearA Player 1",
        year: { g: 30, w: 10, d: 0, l: 20 },
        ed11: { g: 12, w: 2, d: 0, l: 10 },
        vs: { "World Eaters": { g: 4, w: 1, d: 0, l: 3 } },
        as: {},
      },
    },
  };
}
