// Faction-versus-faction edge for the board forecast (contract C4). Shared by the page and the tests: no
// server-only imports. The data is src/lib/wdc/matchup-snapshot.json, built by
// scripts/statcheck-matchups.mjs from Stat Check's public Matchup Matrix dashboard.

/** One matchup row: the player faction's win rate (draws count half) against one opponent faction, and its games. */
export type MatchupRow = { wr: number; games: number };

/** Shape of matchup-snapshot.json. `rows[playerFaction][opponentFaction]`, both in Stat Check's spelling. */
export type MatchupSnapshot = {
  generatedAt: string;
  source: string;
  /** The dashboard's Meta filter selection when it was read ("Armageddon 1.04"), or null. */
  meta: string | null;
  /** The dashboard's own "Last Updated" date as YYYY-MM-DD, or null. */
  updated?: string | null;
  rows: Record<string, Record<string, MatchupRow>>;
};

/** Pseudo-games of a 50% prior the matchup win rate is shrunk toward: a 5-game row moves the forecast a little, a 100-game row a lot. */
export const MATCHUP_PRIOR_GAMES = 20;
const WR_FLOOR = 0.05;
const WR_CEIL = 0.95;

// BCP spellings that differ from Stat Check's after factionKey's folding, keyed and valued in key form.
const ALIASES: Record<string, string> = {
  "genestealer cult": "genestealer cults",
};

/**
 * A faction name folded for matching BCP against Stat Check: lower case, a trailing parenthetical
 * dropped ("Space Marines (Astartes)" is "space marines"), apostrophes removed ("T'au" is "tau"),
 * other punctuation to spaces, spaces collapsed, then the alias map. "" for an empty name.
 * Whether the key is a known faction is the snapshot's call (resolveFaction): BCP "Imperium" folds
 * to "imperium", which Stat Check does not list, so it is unknown.
 */
export function factionKey(name: string): string {
  const key = (name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s*\([^()]*\)\s*$/, "")
    .replace(/['‘’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return Object.prototype.hasOwnProperty.call(ALIASES, key) ? ALIASES[key] : key;
}

const indexes = new WeakMap<MatchupSnapshot, Map<string, string>>();

/** Stat Check's spelling of a BCP faction name, or null when the snapshot does not list it. */
export function resolveFaction(snapshot: MatchupSnapshot, name: string): string | null {
  let index = indexes.get(snapshot);
  if (!index) {
    index = new Map();
    for (const [p, opps] of Object.entries(snapshot.rows)) {
      index.set(factionKey(p), p);
      for (const o of Object.keys(opps)) if (!index.has(factionKey(o))) index.set(factionKey(o), o);
    }
    indexes.set(snapshot, index);
  }
  const key = factionKey(name);
  return key ? (index.get(key) ?? null) : null;
}

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** The matchup behind a faction edge, as the board labels it. `wr` is the raw (unshrunk) win rate for `us`. */
export type FactionMatchup = { us: string; them: string; wr: number; games: number; edge: number };

/**
 * The matchup for our faction against theirs: our row against them when the snapshot has it, else
 * their row against us mirrored (1 - wr). Null for an unknown faction, a mirror, or no row.
 */
export function factionMatchup(
  snapshot: MatchupSnapshot,
  usFaction: string,
  themFaction: string,
): FactionMatchup | null {
  const us = resolveFaction(snapshot, usFaction);
  const them = resolveFaction(snapshot, themFaction);
  if (!us || !them || us === them) return null;
  let row: MatchupRow | null = null;
  if (hasOwn(snapshot.rows, us) && hasOwn(snapshot.rows[us], them)) row = snapshot.rows[us][them];
  else if (hasOwn(snapshot.rows, them) && hasOwn(snapshot.rows[them], us)) {
    const r = snapshot.rows[them][us];
    row = { wr: 1 - r.wr, games: r.games };
  }
  if (!row || !Number.isFinite(row.wr) || !Number.isFinite(row.games) || row.games <= 0)
    return null;
  return { us, them, wr: row.wr, games: row.games, edge: edgeFromRow(row) };
}

/** Shrunk win rate for a row: (wr * games + 0.5 * K) / (games + K), clamped to 0.05..0.95. */
export const shrunkWinRate = (row: MatchupRow): number => {
  const k = MATCHUP_PRIOR_GAMES;
  const wr = (row.wr * row.games + 0.5 * k) / (row.games + k);
  return Math.max(WR_FLOOR, Math.min(WR_CEIL, wr));
};

const edgeFromRow = (row: MatchupRow): number => {
  const p = shrunkWinRate(row);
  return Math.log(p / (1 - p));
};

/** Log-odds edge for us from the faction matchup (added to the Elo log-odds in forecastPoints); 0 when unknown, a mirror, or no row. */
export const factionEdge = (
  snapshot: MatchupSnapshot,
  usFaction: string,
  themFaction: string,
): number => factionMatchup(snapshot, usFaction, themFaction)?.edge ?? 0;
