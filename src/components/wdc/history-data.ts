// The BCP player history snapshot for the board forecast (docs/HISTORY.md), loaded through a
// guarded import: import.meta.glob resolves to an empty map when
// src/lib/wdc/player-history-snapshot.json is missing at build time, so the board then runs with no
// history (every form and history edge 0) instead of failing the build. The render tests mock this
// module to hand the board a fixture snapshot.
import { EMPTY_HISTORY, type PlayerHistorySnapshot } from "../../lib/wdc/history";

const found = import.meta.glob<unknown>("../../lib/wdc/player-history-snapshot.json", {
  eager: true,
  import: "default",
});

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A loaded snapshot, or the empty one when the file is missing or not shaped like a snapshot. */
export function asHistorySnapshot(v: unknown): PlayerHistorySnapshot {
  if (!isRecord(v) || !isRecord(v.players)) return EMPTY_HISTORY;
  return v as unknown as PlayerHistorySnapshot;
}

export const HISTORY: PlayerHistorySnapshot = asHistorySnapshot(Object.values(found)[0]);
