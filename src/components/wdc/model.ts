// Pure board logic for the board page (contract C4, C6, C7). No React, no I/O: the page component
// and the render tests both lean on these, and the forecast math itself comes from lib/wdc/types.
import {
  forecastPoints,
  WDC_DRAW,
  WDC_GAME_MAX,
  WDC_GAMES,
  WDC_WIN,
  type WdcBoardState,
  type WdcCoachState,
  type WdcPlayer,
  type WdcRound,
  type WdcTable,
  type WdcTeam,
} from "../../lib/wdc/types";
import { coachEntry, coachPlayerKey, oppMatches } from "../../lib/wdc/keys";
import matchupSnapshot from "../../lib/wdc/matchup-snapshot.json";
import { factionMatchup, type FactionMatchup, type MatchupSnapshot } from "../../lib/wdc/matchups";
import {
  DEFAULT_WEIGHTS,
  formEdge,
  historyEdge,
  historyNote,
  resolveWeights,
  type PlayerHistorySnapshot,
  type WdcWeights,
} from "../../lib/wdc/history";
import { HISTORY } from "./history-data";

export const NUDGE_LIMIT = 20;

/** Stat Check faction matchups (C4), bundled with the page: about 27 KB minified, 3 KB gzipped. */
export const MATCHUPS = matchupSnapshot as unknown as MatchupSnapshot;

/** A faction edge that moves a forecast by this many points or more is marked in the pairing grid. */
export const FACTION_MARK_POINTS = 2;

/** A form plus history shift of this many points or more is marked "H" in the pairing grid. */
export const HISTORY_MARK_POINTS = 2;

/** What a forecast reads besides the two players: the snapshots and the coach's weights (C3). */
export type ForecastContext = {
  matchups?: MatchupSnapshot;
  history?: PlayerHistorySnapshot;
  /** Already resolved; missing means DEFAULT_WEIGHTS. */
  weights?: WdcWeights;
};

export type PairForecast = {
  /** Our points: Elo plus the weighted faction, form and history edges, then the nudge (forecastPoints). */
  points: number;
  /** The same forecast with no edge at all (Elo and the nudge only). */
  eloOnly: number;
  /** The forecast without the faction term, for the "F" marker. */
  noFaction: number;
  /** The forecast without the form and history terms, for the "H" marker. */
  noHistory: number;
  matchup: FactionMatchup | null;
  /** The unweighted log-odds edges for us. */
  edges: { faction: number; form: number; history: number };
};

/**
 * One pair's forecast (C4, docs/HISTORY.md), the single source for the board cards, the strip
 * totals, the score pad outline and the pairing grid:
 *   logit = Elo term + wFaction * factionEdge + wForm * formEdge + wHistory * historyEdge,
 * then round(20p) clamped 0..20, then the coach nudge (forecastPoints). With weights
 * {faction: 1, form: 0, history: 0} the extra terms are exactly 0, so the result is the Elo plus
 * faction forecast bit for bit.
 */
export function pairForecast(
  us: WdcPlayer,
  them: WdcPlayer,
  nudge = 0,
  ctx: ForecastContext = {},
): PairForecast {
  const w = ctx.weights ?? DEFAULT_WEIGHTS;
  const history = ctx.history ?? HISTORY;
  const matchup = factionMatchup(ctx.matchups ?? MATCHUPS, us.faction, them.faction);
  const edges = {
    faction: matchup?.edge ?? 0,
    form: formEdge(history, us.name, them.name),
    history: historyEdge(history, us, them),
  };
  const fTerm = w.faction * edges.faction;
  const hTerm = w.form * edges.form + w.history * edges.history;
  return {
    points: forecastPoints(us.elo, them.elo, nudge, fTerm + hTerm),
    eloOnly: forecastPoints(us.elo, them.elo, nudge),
    noFaction: forecastPoints(us.elo, them.elo, nudge, hTerm),
    noHistory: forecastPoints(us.elo, them.elo, nudge, fTerm),
    matchup,
    edges,
  };
}

/** The board's forecast context: the coach document's weights (defaults when missing). */
export const forecastContext = (state: WdcBoardState): ForecastContext => ({
  weights: resolveWeights(state.coach.weights),
});

/**
 * The player-history numbers behind a pairing cell, ours then theirs, for its label:
 * "Ethan Davis (World Eaters, Purge the Foe) 5W 0D 1L into Necrons in 11th; 22W 0D 9L in 11th overall". Empty when
 * the snapshot has neither player.
 */
export function pairHistoryLabel(
  us: WdcPlayer,
  them: WdcPlayer,
  history: PlayerHistorySnapshot = HISTORY,
): string {
  return [historyNote(history, us, them.faction), historyNote(history, them, us.faction)]
    .filter(Boolean)
    .join(". ");
}

/** True when the snapshot has at least one player (the footnote names the source only then). */
export const historyLoaded = (history: PlayerHistorySnapshot = HISTORY): boolean =>
  !!history.players && Object.keys(history.players).length > 0;

/** "1.0x", "0.5x", "0.75x" for the Weights sheet. */
export const weightLabel = (v: number): string =>
  `${Number.isInteger(v * 2) ? v.toFixed(1) : v.toFixed(2)}x`;

export const withWeights = (state: WdcBoardState, weights: WdcWeights): WdcCoachState => ({
  ...state.coach,
  weights,
});

/** "Faction matchup: Adeptus Custodes 60% vs Adepta Sororitas over 5 games" (raw win rate, before the shrink). */
export const matchupLabel = (m: FactionMatchup): string =>
  `Faction matchup: ${m.us} ${Math.round(m.wr * 100)}% vs ${m.them} over ${m.games} ${m.games === 1 ? "game" : "games"}`;

/** "Stat Check faction matchups (Armageddon 1.04, updated 2026-10-14)" for the board footnote. */
export function matchupSourceLabel(snapshot: MatchupSnapshot = MATCHUPS): string {
  const updated = `updated ${snapshot.updated || snapshot.generatedAt.slice(0, 10)}`;
  return `Stat Check faction matchups (${snapshot.meta ? `${snapshot.meta}, ${updated}` : updated})`;
}

export const listHref = (p: WdcPlayer): string | null =>
  p.list ? `https://www.bestcoastpairings.com/list/${encodeURIComponent(p.list)}` : null;

const UNKNOWN = (name: string): WdcPlayer => ({
  name,
  team: "",
  faction: "",
  dispo: "",
  elo: 1400,
  eloKnown: false,
  list: null,
});

/** Name to player lookup across every team in the event. */
export function playerIndex(state: WdcBoardState): (name: string) => WdcPlayer {
  const byName = new Map<string, WdcPlayer>();
  for (const team of Object.values(state.teams)) {
    for (const p of team.players) byName.set(p.name, p);
  }
  return (name) => byName.get(name) ?? UNKNOWN(name);
}

/** Points we hold for a table: the BCP result wins, then the coach's entry, else null. */
export const tableScore = (t: WdcTable): number | null => t.bcpScore ?? t.coachScore ?? null;

export type Verdict = { cls: "win" | "draw" | "loss"; label: "Win" | "Draw" | "Loss" };

export const verdictFor = (total: number): Verdict =>
  total >= WDC_WIN
    ? { cls: "win", label: "Win" }
    : total === WDC_DRAW
      ? { cls: "draw", label: "Draw" }
      : { cls: "loss", label: "Loss" };

export type NeedLine =
  | { kind: "final"; locked: number; theirs: number; verdict: Verdict }
  | { kind: "won"; locked: number; left: number }
  | { kind: "out"; best: number }
  | {
      kind: "open";
      toWin: number;
      toDraw: number;
      left: number;
      perGame: string;
      drawCeiling: boolean;
    };

export type Strip = {
  forecasts: number[];
  predicted: number;
  locked: number;
  scored: number;
  total: number;
  left: number;
  projected: number;
  maxPossible: number;
  need: NeedLine;
};

/** The team strip numbers (C4) for one round's tables. */
export function stripFor(
  round: WdcRound,
  player: (name: string) => WdcPlayer,
  ctx: ForecastContext = {},
): Strip {
  const forecasts = round.tables.map(
    (t) => pairForecast(player(t.us), player(t.them), t.nudge, ctx).points,
  );
  const predicted = forecasts.reduce((a, b) => a + b, 0);
  let locked = 0;
  let scored = 0;
  let predRest = 0;
  round.tables.forEach((t, i) => {
    const s = tableScore(t);
    if (s != null) {
      locked += s;
      scored += 1;
    } else {
      predRest += forecasts[i];
    }
  });
  const total = round.tables.length;
  const left = total - scored;
  const projected = locked + predRest;
  const maxPossible = locked + left * WDC_GAME_MAX;
  let need: NeedLine;
  if (left === 0) {
    need = {
      kind: "final",
      locked,
      theirs: WDC_GAMES * WDC_GAME_MAX - locked,
      verdict: verdictFor(locked),
    };
  } else if (locked >= WDC_WIN) {
    need = { kind: "won", locked, left };
  } else if (maxPossible < WDC_DRAW) {
    need = { kind: "out", best: maxPossible };
  } else {
    const toWin = WDC_WIN - locked;
    need = {
      kind: "open",
      toWin,
      toDraw: WDC_DRAW - locked,
      left,
      perGame: (toWin / left).toFixed(1),
      drawCeiling: maxPossible === WDC_DRAW,
    };
  }
  return { forecasts, predicted, locked, scored, total, left, projected, maxPossible, need };
}

export const averageElo = (names: string[], player: (name: string) => WdcPlayer): number =>
  names.length ? Math.round(names.reduce((a, n) => a + player(n).elo, 0) / names.length) : 0;

/** Opponent picker (C6): teams within one match result (2 match points) of ours, minus ourselves and teams already played, by placing. */
export function opponentShortlist(state: WdcBoardState): WdcTeam[] {
  const us = state.teams[state.our];
  const ours = us ? us.matchPoints : 0;
  const played = new Set(state.played);
  return Object.values(state.teams)
    .filter(
      // one match result is 2 match points (win 2, draw 1): teams within one result of us
      (t) => t.name !== state.our && !played.has(t.name) && Math.abs(t.matchPoints - ours) <= 2,
    )
    .sort(byPlacing);
}

/** Every team we could still draw, same ordering (the "Show all" list). */
export function opponentsAll(state: WdcBoardState): WdcTeam[] {
  return Object.values(state.teams)
    .filter((t) => t.name !== state.our)
    .sort(byPlacing);
}

function byPlacing(a: WdcTeam, b: WdcTeam): number {
  const pa = a.placing ?? Number.MAX_SAFE_INTEGER;
  const pb = b.placing ?? Number.MAX_SAFE_INTEGER;
  return pa - pb || a.name.localeCompare(b.name);
}

/**
 * The round the Pairing tab sets tables for: the first round BCP has not posted. Null when BCP has
 * posted every round (C6: the BCP tables win once they exist, so there is nothing left to pair).
 */
export function pairingRound(state: WdcBoardState): number | null {
  const posted = new Set(state.rounds.filter((r) => r.fromBcp).map((r) => r.n));
  for (let n = 1; n <= state.event.rounds; n++) if (!posted.has(n)) return n;
  return null;
}

/** The stored pairing, ignoring one whose opponent BCP now lists as played (those locks are history). */
export function activePairing(state: WdcBoardState): WdcCoachState["pairing"] {
  const p = state.coach.pairing;
  if (p.opp && state.played.includes(p.opp)) return { opp: "", locks: [] };
  return p;
}

/**
 * The coach document with one table's score and/or nudge changed (C3). The entry is keyed by our
 * player on that table (coachPlayerKey), never by table number, and the round's `opp` is set to the
 * opponent the round shows. Entries the round stored against another opponent are not shown on this
 * board (oppMatches), so the first write against the shown opponent starts the round afresh rather
 * than carrying them over. Unspecified fields keep their stored value.
 */
export function withTable(
  state: WdcBoardState,
  round: WdcRound,
  table: WdcTable,
  patch: { score?: number | null; nudge?: number },
): WdcCoachState {
  const key = String(round.n);
  const stored = Object.prototype.hasOwnProperty.call(state.coach.rounds, key)
    ? state.coach.rounds[key]
    : undefined;
  const kept = stored && oppMatches(stored.opp, round.opp) ? stored : undefined;
  const prev = coachEntry(kept, table.us);
  const score = patch.score !== undefined ? patch.score : prev ? prev.score : table.coachScore;
  const nudge = patch.nudge !== undefined ? patch.nudge : prev ? prev.nudge : table.nudge;
  const opp = round.opp || kept?.opp;
  const rounds = { ...state.coach.rounds };
  rounds[key] = {
    ...(opp ? { opp } : {}),
    players: { ...(kept?.players ?? {}), [coachPlayerKey(table.us)]: { score, nudge } },
  };
  return { ...state.coach, rounds };
}

export const withPairing = (
  state: WdcBoardState,
  pairing: WdcCoachState["pairing"],
): WdcCoachState => ({
  ...state.coach,
  pairing,
});

/**
 * Optimistic client mirror of the server merge (C3): a coach document applied over the board, so a
 * nudge shows at once. The server's reply replaces this as soon as it arrives.
 */
export function applyCoach(state: WdcBoardState, coach: WdcCoachState): WdcBoardState {
  return {
    ...state,
    coach,
    rounds: state.rounds.map((r) => {
      const key = String(r.n);
      const stored = Object.prototype.hasOwnProperty.call(coach.rounds, key)
        ? coach.rounds[key]
        : undefined;
      if (!stored || !oppMatches(stored.opp, r.opp)) return r;
      return {
        ...r,
        tables: r.tables.map((t) => {
          const c = coachEntry(stored, t.us);
          return c ? { ...t, coachScore: c.score, nudge: c.nudge } : t;
        }),
      };
    }),
  };
}

/** "hh:mm" in the viewer's local time for the stale line. */
export function clockLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
