// Shared shapes for the Warp Dust Crusaders coach board. Contract: docs/CONTRACT.md.
// This file is the seam between the BCP client (bcp.server.ts), the state layer the Worker wraps
// (state.server.ts, src/worker/handler.ts) and the page (src/app.tsx, components/wdc): change it
// only with all three.

/** One player as the board shows them. `elo` is resolved per C5; `eloKnown` is false on the 1400 fallback. */
export type WdcPlayer = {
  name: string;
  team: string;
  faction: string;
  dispo: string;
  elo: number;
  eloKnown: boolean;
  /** BCP army-list id; the link is https://www.bestcoastpairings.com/list/{list}. Null when BCP shows "No List". */
  list: string | null;
};

export type WdcTeam = {
  name: string;
  captain: string | null;
  /** 1-based live placing from BCP standings. */
  placing: number | null;
  matchPoints: number;
  battlePoints: number;
  gameWins: number;
  players: WdcPlayer[];
};

/** One of our eight games in a round. `score` is OUR points 0..20 (theirs is 20 - score); null until known. */
export type WdcTable = {
  t: number;
  us: string;
  them: string;
  /** Points as posted on BCP, or null while the game is open. Wins over `coachScore` when present. */
  bcpScore: number | null;
  coachScore: number | null;
  nudge: number;
};

export type WdcRound = {
  n: number;
  opp: string;
  /** True once BCP published this round's pairings; false when the tables came from the coach's pairing locks. */
  fromBcp: boolean;
  tables: WdcTable[];
};

/** One coach entry for one of our players in one round: our points 0..20 (or null) and the forecast nudge. */
export type WdcCoachEntry = { score: number | null; nudge: number };

/**
 * One round of coach entries (C3). Entries are keyed by OUR player's name through normalizeName (elo.ts),
 * never by table number: BCP renumbers tables, a player is the same player. `opp` is the opponent the
 * page showed for the round when the entries were written; when it is set and BCP pairs the round
 * against another team, the entries are not shown (but stay stored).
 */
export type WdcCoachRound = { opp?: string; players: Record<string, WdcCoachEntry> };

/**
 * Forecast weights the coach sets (C3, docs/HISTORY.md): multipliers on the faction matchup,
 * last-year form and 11th-edition-vs-this-army log-odds edges, each 0..2 in steps of 0.25.
 * Missing means the defaults (faction 1, form 0.5, history 1; DEFAULT_WEIGHTS in history.ts).
 */
export type WdcWeights = { faction: number; form: number; history: number };

/** The coach-owned document in KV key `wdc.state.{eventId}` (C3). */
export type WdcCoachState = {
  rounds: Record<string, WdcCoachRound>;
  pairing: { opp: string; locks: Array<{ us: string; them: string }> };
  eloOverrides: Record<string, number>;
  /** Forecast weights; absent means the defaults. */
  weights?: WdcWeights;
};

/** Everything the page renders, produced server-side by merging BCP (C2) with the coach state (C3). */
export type WdcBoardState = {
  event: { id: string; name: string; where: string; rounds: number; teamSize: number };
  our: string;
  teams: Record<string, WdcTeam>;
  rounds: WdcRound[];
  currentRound: number;
  /** Teams we already faced, for the pairing shortlist (C6). */
  played: string[];
  coach: WdcCoachState;
  /** ISO time of the last successful BCP read; `stale` is true when the render used an older cached copy. */
  bcpAt: string | null;
  stale: boolean;
  eloSource: string;
  pinSet: boolean;
};

export const WDC_WIN = 81;
export const WDC_DRAW = 80;
export const WDC_GAME_MAX = 20;
export const WDC_GAMES = 8;

/**
 * Elo points for a tenfold edge in the forecast. Chess Elo uses 400; the board uses a steeper 290 so
 * predictions spread across 0-20 for real 40K Elo gaps (owner 2026-10-17: predictions sat at 7-13).
 * A 100-point edge reads about 14-6, 200 about 17-3, 330 about 19-1.
 */
export const WDC_ELO_SCALE = 290;

export const expectedShare = (usElo: number, themElo: number): number =>
  1 / (1 + Math.pow(10, (themElo - usElo) / WDC_ELO_SCALE));

/**
 * Our expected share with an edge (C4): the edge is log-odds for us added to the Elo log-odds,
 * p = 1 / (1 + 10^((themElo - usElo)/scale) * e^(-edge)). The board passes the weighted sum of the
 * faction, form and history edges (pairForecast in components/wdc/model.ts, docs/HISTORY.md).
 * With edge 0 the factor is exactly 1, so this equals expectedShare bit for bit.
 */
export const expectedShareWithEdge = (usElo: number, themElo: number, edge = 0): number =>
  1 / (1 + Math.pow(10, (themElo - usElo) / WDC_ELO_SCALE) * Math.exp(-edge));

/**
 * Forecast of our points for one pair (C4): Elo expectancy, with the faction matchup edge when one
 * is given, on a 20-point game, clamped to 0..20, then the nudge, clamped again (owner 2026-10-17:
 * the full 0-20 range). Edge 0 is the Elo-only forecast exactly.
 */
export const forecastPoints = (usElo: number, themElo: number, nudge = 0, edge = 0): number => {
  const raw = Math.round(WDC_GAME_MAX * expectedShareWithEdge(usElo, themElo, edge));
  const base = Math.max(0, Math.min(20, raw));
  return Math.max(0, Math.min(20, base + nudge));
};
