// Player history aggregation for the board forecast (docs/HISTORY.md). Pure: no imports, so
// scripts/bcp-history.mjs can load it under Node's type stripping as well as Bun, and the tests
// can feed it hand-made BCP pairing rows.
//
// BCP result encoding, read from TEO-8 rounds 1-4 (2026-10-17): player{1,2}Game.result is 2 for a
// win, 1 for a draw, 0 for a loss. The two seats of a row always pair 2/0 or 1/1. Points agree
// except on 10-10 games, which TEO-8 breaks with a tiebreak (result 2/0 at 10-10), so the result
// code is the authority and points are never read. Byes have no opponent seat (or a dashes name).

/** Games, wins, draws, losses. g = w + d + l always. */
export type HistRecord = { g: number; w: number; d: number; l: number };

export type HistAsRecord = HistRecord & { vs: Record<string, HistRecord> };

/** One player's entry in player-history-snapshot.json. */
export type PlayerHistory = {
  name: string;
  /** Every 40K game in the window. */
  year: HistRecord;
  /** Games on or after editionStart. */
  ed11: HistRecord;
  /** ed11 games by opponent army (Stat Check faction name, or the folded BCP name when unknown). */
  vs: Record<string, HistRecord>;
  /** ed11 games by "<myFaction>|<myDisposition>", each with its own vs split. */
  as: Record<string, HistAsRecord>;
};

/** Shape of src/lib/wdc/player-history-snapshot.json, keyed by normalizeName(display name). */
export type PlayerHistorySnapshot = {
  generatedAt: string;
  eventId: string;
  windowStart: string;
  editionStart: string;
  players: Record<string, PlayerHistory>;
};

export type HistResult = "w" | "d" | "l";

/** One finished game from one player's side. Factions are already folded; "" when BCP has none. */
export type HistGame = {
  /** Event date, YYYY-MM-DD. */
  date: string;
  result: HistResult;
  myFaction: string;
  myDispo: string;
  oppFaction: string;
};

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

/** A BCP string field that may also arrive as {name}; "" for missing or the literal "undefined". */
export const bcpName = (v: unknown): string => {
  const s = typeof v === "string" ? v : isObj(v) && typeof v.name === "string" ? v.name : "";
  const t = s.trim();
  return t === "undefined" || t === "null" ? "" : t;
};

/** 2 win, 1 draw, 0 loss; anything else is no result. */
export const resultOf = (code: unknown): HistResult | null =>
  code === 2 ? "w" : code === 1 ? "d" : code === 0 ? "l" : null;

const seatId = (row: Raw, slot: 1 | 2): string => {
  const seat = row[`player${slot}`];
  if (isObj(seat) && typeof seat.id === "string") return seat.id;
  const id = row[`player${slot}Id`];
  return typeof id === "string" ? id : "";
};

/** A seat with a real player: BCP fills a bye with null or a dashes name. */
const seatIsPlayer = (seat: unknown): seat is Raw => {
  if (!isObj(seat)) return false;
  const user = isObj(seat.user) ? seat.user : null;
  if (!user) return typeof seat.id === "string" && seat.id !== "";
  const name = `${bcpName(user.firstName)} ${bcpName(user.lastName)}`.trim();
  return name !== "" && !/^[-\s]+$/.test(name);
};

export type PairingContext = {
  /** The event-player id whose games these are. */
  eventPlayerId: string;
  /** Event date, YYYY-MM-DD. */
  date: string;
  /** BCP faction name -> snapshot key (Stat Check name, else the folded BCP name). */
  fold: (faction: string) => string;
  /** The entry's own faction and disposition, used when a pairing seat leaves them blank. */
  fallbackFaction?: string;
  fallbackDispo?: string;
};

export type PairingTally = {
  games: HistGame[];
  byes: number;
  unfinished: number;
  mismatched: number;
};

/**
 * The finished games in one player's /players/{eventPlayerId}/pairings rows. A row is kept when the
 * player sits in it, the other seat is a player or the row has a played score of 1..19 with no opponent
 * recorded (byes are counted, not kept), the row is done and the
 * player's game carries a result code. Rows are de-duplicated by id. `mismatched` counts rows whose two
 * result codes do not pair (2/0, 1/1, 0/2); the player's own code is still used.
 */
export const gamesFromPairings = (rows: unknown, ctx: PairingContext): PairingTally => {
  const out: PairingTally = { games: [], byes: 0, unfinished: 0, mismatched: 0 };
  if (!Array.isArray(rows)) return out;
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isObj(row)) continue;
    const id = typeof row.id === "string" ? row.id : "";
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const slot =
      seatId(row, 1) === ctx.eventPlayerId ? 1 : seatId(row, 2) === ctx.eventPlayerId ? 2 : 0;
    if (slot === 0) continue;
    const other = slot === 1 ? 2 : 1;
    const mine = row[`player${slot}`];
    const theirs = row[`player${other}`];
    const myGame = row[`player${slot}Game`];
    // No opponent recorded. A real bye scores a flat 20 (or nothing); a played game whose opponent BCP
    // lost still carries a real score between 1 and 19 (owner 2026-10-18: ATC Tennessee round 1, 12-8).
    const pts = isObj(myGame) && typeof myGame.points === "number" ? myGame.points : null;
    const playedNoOpp = !seatIsPlayer(theirs) && pts !== null && pts > 0 && pts < 20;
    if (!seatIsPlayer(theirs) && !playedNoOpp) {
      out.byes++;
      continue;
    }
    const theirGame = row[`player${other}Game`];
    const result = isObj(myGame) ? resultOf(myGame.result) : null;
    if (row.isDone !== true || result === null) {
      out.unfinished++;
      continue;
    }
    const theirCode = isObj(theirGame) ? resultOf(theirGame.result) : null;
    const pairsWith: Record<HistResult, HistResult> = { w: "l", d: "d", l: "w" };
    if (theirCode !== null && theirCode !== pairsWith[result]) out.mismatched++;
    const mySeat = isObj(mine) ? mine : {};
    const myFactionName = bcpName(mySeat.faction) || ctx.fallbackFaction || "";
    out.games.push({
      date: ctx.date,
      result,
      myFaction: myFactionName ? ctx.fold(myFactionName) : "",
      myDispo: bcpName(mySeat.subFaction) || ctx.fallbackDispo || "",
      oppFaction: isObj(theirs) && bcpName(theirs.faction) ? ctx.fold(bcpName(theirs.faction)) : "",
    });
  }
  return out;
};

export const emptyRecord = (): HistRecord => ({ g: 0, w: 0, d: 0, l: 0 });

const add = (rec: HistRecord, r: HistResult): void => {
  rec.g++;
  rec[r]++;
};

const sortKeys = <T>(o: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

/**
 * One player's history from their games. `year` counts games dated windowStart..through (inclusive,
 * through defaults to no upper bound); `ed11`, `vs` and `as` count the subset dated on or after
 * editionStart. A game with no opponent faction counts in the totals and its `as` row but in no `vs`
 * split; one with no own faction counts in the totals but in no `as` row.
 */
export const aggregateHistory = (
  name: string,
  games: readonly HistGame[],
  window: { windowStart: string; editionStart: string; through?: string },
): PlayerHistory => {
  const year = emptyRecord();
  const ed11 = emptyRecord();
  const vs: Record<string, HistRecord> = {};
  const as: Record<string, HistAsRecord> = {};
  for (const g of games) {
    if (g.date < window.windowStart) continue;
    if (window.through && g.date > window.through) continue;
    add(year, g.result);
    if (g.date < window.editionStart) continue;
    add(ed11, g.result);
    if (g.oppFaction) add((vs[g.oppFaction] ||= emptyRecord()), g.result);
    if (g.myFaction) {
      const row = (as[`${g.myFaction}|${g.myDispo}`] ||= { ...emptyRecord(), vs: {} });
      add(row, g.result);
      if (g.oppFaction) add((row.vs[g.oppFaction] ||= emptyRecord()), g.result);
    }
  }
  const asSorted: Record<string, HistAsRecord> = {};
  for (const [k, v] of Object.entries(sortKeys(as))) asSorted[k] = { ...v, vs: sortKeys(v.vs) };
  return { name, year, ed11, vs: sortKeys(vs), as: asSorted };
};
