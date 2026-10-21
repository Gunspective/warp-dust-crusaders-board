// Player history edges for the board forecast (docs/HISTORY.md, contract C4). Pure: no server
// code and no data import, so the page and the tests share it. The data is
// src/lib/wdc/player-history-snapshot.json, written by scripts/bcp-history.mjs; the page
// loads it through a guarded import (components/wdc/history-data.ts), so a missing file means no
// history, never a broken board.
import { normalizeName } from "./elo";
import { factionKey } from "./matchups";
import type { HistRecord, PlayerHistory, PlayerHistorySnapshot } from "./history-aggregate";
import type { WdcWeights } from "./types";

// The snapshot shapes are the generator's (history-aggregate.ts, t-738); aliased here for the board.
export type { PlayerHistorySnapshot, WdcWeights };
/** Games, wins, draws, losses. */
export type HistoryRecord = HistRecord;
/** One player's history. `vs` and `as` hold 11th edition games only; `as` keys are "<faction>|<disposition>". */
export type PlayerHistoryEntry = PlayerHistory;

/** No history at all: what the board uses when the snapshot file is missing or out of shape. */
export const EMPTY_HISTORY: PlayerHistorySnapshot = {
  generatedAt: "",
  eventId: "",
  windowStart: "",
  editionStart: "",
  players: {},
};

/** Pseudo-games of a 50% prior the 11th edition win share is shrunk toward (HISTORY.md: K = 20). */
export const FORM_PRIOR_GAMES = 20;
/** Pseudo-games of a 50% prior for the 11th edition shares, overall and against one army (K = 10). */
export const HISTORY_PRIOR_GAMES = 10;

export const DEFAULT_WEIGHTS: WdcWeights = { faction: 1, form: 0.5, history: 1 };
export const WEIGHT_MIN = 0;
export const WEIGHT_MAX = 2;
export const WEIGHT_STEP = 0.25;

/** A weight the coach document may hold: a number 0..2 on a 0.25 step. */
export const isWeight = (v: unknown): v is number =>
  typeof v === "number" &&
  Number.isFinite(v) &&
  v >= WEIGHT_MIN &&
  v <= WEIGHT_MAX &&
  Number.isInteger(v / WEIGHT_STEP);

const pickWeight = (v: unknown, fallback: number): number => (isWeight(v) ? v : fallback);

/** The stored weights with a default for each one missing (or out of shape). */
export const resolveWeights = (w: Partial<WdcWeights> | undefined | null): WdcWeights => ({
  faction: pickWeight(w?.faction, DEFAULT_WEIGHTS.faction),
  form: pickWeight(w?.form, DEFAULT_WEIGHTS.form),
  history: pickWeight(w?.history, DEFAULT_WEIGHTS.history),
});

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** A record the math can use: finite counts, at least one game, wins plus draws within the games. */
const usable = (r: HistoryRecord | null | undefined): r is HistoryRecord =>
  !!r &&
  Number.isFinite(r.g) &&
  Number.isFinite(r.w) &&
  Number.isFinite(r.d) &&
  r.g > 0 &&
  r.w >= 0 &&
  r.d >= 0 &&
  r.w + r.d <= r.g;

/**
 * Win share (w + d/2) / g shrunk toward 0.5 by K pseudo-games: (w + d/2 + 0.5K) / (g + K).
 * No record (or no games) is exactly 0.5.
 */
export const shrunkShare = (r: HistoryRecord | null | undefined, k: number): number =>
  usable(r) ? (r.w + r.d / 2 + 0.5 * k) / (r.g + k) : 0.5;

export const logit = (p: number): number => Math.log(p / (1 - p));

/** One player's history entry, looked up by normalizeName(display name). */
export const historyFor = (
  snapshot: PlayerHistorySnapshot,
  name: string,
): PlayerHistoryEntry | null => {
  const players = snapshot?.players;
  if (!players) return null;
  const key = normalizeName(name);
  return key && hasOwn(players, key) ? players[key] : null;
};

/** The entry of `rows` for an army, matched through factionKey ("Space Marines (Astartes)" finds "Space Marines"). */
function armyRow<T>(rows: Record<string, T> | undefined, faction: string): T | null {
  if (!rows) return null;
  const want = factionKey(faction);
  if (!want) return null;
  if (hasOwn(rows, faction)) return rows[faction];
  for (const k of Object.keys(rows)) if (factionKey(k) === want) return rows[k];
  return null;
}

const dispoKey = (s: string): string => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** The `as` entry for what the player brought, "<faction>|<disposition>". */
const asRow = (h: PlayerHistoryEntry, faction: string, dispo: string) => {
  const rows = h.as;
  if (!rows) return null;
  const want = factionKey(faction);
  if (!want) return null;
  const d = dispoKey(dispo);
  for (const k of Object.keys(rows)) {
    const bar = k.indexOf("|");
    const f = bar < 0 ? k : k.slice(0, bar);
    const kd = bar < 0 ? "" : k.slice(bar + 1);
    if (factionKey(f) === want && dispoKey(kd) === d) return { key: k, row: rows[k] };
  }
  return null;
};

/** Who a history edge reads: the player's display name, army and disposition. */
export type HistorySide = { name: string; faction: string; dispo: string };

/** The 11th edition record a player has into one army, and where it came from. */
export type ArmyRecord = {
  record: HistoryRecord;
  /** True when it is the "<faction>|<disposition>" row (what they bring today), false for the overall `vs` row. */
  asBrought: boolean;
};

/**
 * The player's 11th edition record into `themFaction`: the `as["<myFaction>|<myDispo>"].vs` row
 * when it has games, else the overall `vs` row, else null.
 */
export const armyRecord = (
  h: PlayerHistoryEntry | null,
  me: HistorySide,
  themFaction: string,
): ArmyRecord | null => {
  if (!h) return null;
  const as = asRow(h, me.faction, me.dispo);
  const brought = as ? armyRow(as.row.vs, themFaction) : null;
  if (usable(brought)) return { record: brought, asBrought: true };
  const vs = armyRow(h.vs, themFaction);
  if (usable(vs)) return { record: vs, asBrought: false };
  return null;
};

/**
 * 11th edition form edge (log-odds for us; owner 2026-10-18 "Only do it for 11th"):
 *   formEdge = logit(shrunk(us.ed11, K=20)) - logit(shrunk(them.ed11, K=20)),
 * shrunk(r, K) = (w + d/2 + 0.5K) / (g + K). A player with no entry is the prior (0.5, log-odds 0).
 */
export const formEdge = (snapshot: PlayerHistorySnapshot, us: string, them: string): number => {
  const a = historyFor(snapshot, us);
  const b = historyFor(snapshot, them);
  return (
    logit(shrunkShare(a?.ed11, FORM_PRIOR_GAMES)) - logit(shrunkShare(b?.ed11, FORM_PRIOR_GAMES))
  );
};

/**
 * One side's 11th edition army term: how much better (positive) or worse the player does into
 * this army than their own 11th edition norm. The army record is shrunk toward the player's own
 * shrunk ed11 share p0 (not toward 50%), so a short unbeaten run into an army can never read as
 * underperformance for a strong player (QA 2026-10-18 found 43 of 86 terms sign-inverted when the
 * army record was shrunk toward 50%):
 *   p0   = shrunk(ed11, K=10) toward 0.5
 *   term = logit((w + d/2 + K*p0) / (g + K)) - logit(p0),  K = 10
 * 0 when the player or the army row is missing.
 */
export const armyTerm = (
  snapshot: PlayerHistorySnapshot,
  me: HistorySide,
  themFaction: string,
): number => {
  const h = historyFor(snapshot, me.name);
  const row = armyRecord(h, me, themFaction);
  if (!h || !row) return 0;
  const p0 = shrunkShare(h.ed11, HISTORY_PRIOR_GAMES);
  const r = row.record;
  if (!r || !(r.g > 0)) return 0;
  const toward = (r.w + r.d / 2 + HISTORY_PRIOR_GAMES * p0) / (r.g + HISTORY_PRIOR_GAMES);
  return logit(toward) - logit(p0);
};

/** 11th edition history edge (log-odds for us): our term into their army minus their term into ours. */
export const historyEdge = (
  snapshot: PlayerHistorySnapshot,
  us: HistorySide,
  them: HistorySide,
): number => armyTerm(snapshot, us, them.faction) - armyTerm(snapshot, them, us.faction);

/** Wins, draws and losses spelled out ("57W 2D 10L"): a bare 57-2-10 was misread (owner 2026-10-18). */
const rec = (r: HistoryRecord): string => `${r.w}W ${r.d}D ${r.l}L`;

/**
 * The numbers behind a cell for one player, for the pairing grid label:
 * "Ethan Davis (World Eaters, Purge the Foe) 5W 0D 1L into Necrons in 11th; 22W 0D 9L in 11th overall".
 * Empty when the snapshot has nothing for them.
 */
export const historyNote = (
  snapshot: PlayerHistorySnapshot,
  me: HistorySide,
  themFaction: string,
): string => {
  const h = historyFor(snapshot, me.name);
  if (!h) return "";
  const row = armyRecord(h, me, themFaction);
  const parts: string[] = [];
  if (row) {
    const what = row.asBrought ? ` (${[me.faction, me.dispo].filter(Boolean).join(", ")})` : "";
    parts.push(`${me.name}${what} ${rec(row.record)} into ${themFaction} in 11th`);
  }
  if (usable(h.ed11)) parts.push(`${row ? "" : `${me.name}: `}${rec(h.ed11)} in 11th overall`);
  return parts.join("; ");
};
