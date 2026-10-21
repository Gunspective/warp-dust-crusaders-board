// Keys the server merge (state.server.ts) and the page (components/wdc/model.ts) share for the coach
// document (contract C3). Pure, no server code, so the client bundle imports it as is.
import { normalizeName } from "./elo";
import type { WdcCoachEntry, WdcCoachRound } from "./types";

/** Key of one of our players' coach entries in a round: the normalized name (normalizeName, elo.ts). */
export const coachPlayerKey = (name: string): string => normalizeName(name);

/**
 * Team-name key: case-insensitive, whitespace collapsed, trailing punctuation dropped. The same rule
 * as bcpTeamKey in bcp.server.ts (state.test.ts pins the two equal), so the page can apply it too.
 */
export const teamKey = (name: string): string =>
  name
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.,;:!?]+$/, "")
    .trim();

/** A round's entries apply to a round against `actual` when its stored `opp` is unset or the same team. */
export const oppMatches = (stored: string | undefined, actual: string): boolean =>
  !stored || teamKey(stored) === teamKey(actual);

/**
 * The coach entry for our player `us` in a stored round, or undefined. Own properties only, so a
 * player whose normalized name is "constructor" never reads Object.prototype.
 */
export const coachEntry = (
  round: WdcCoachRound | undefined,
  us: string,
): WdcCoachEntry | undefined => {
  if (!round) return undefined;
  const key = coachPlayerKey(us);
  return Object.prototype.hasOwnProperty.call(round.players, key) ? round.players[key] : undefined;
};
