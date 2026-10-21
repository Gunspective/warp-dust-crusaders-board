// Best Coast Pairings client for the coach board. Contract: docs/CONTRACT.md (C2).
//
// BCP's public API answers without a login when the request carries the header
// `client-id: web-app` (proven 2026-10-16). Endpoints used:
//   events/{id}                                         event (name, city, state, numberOfRounds)
//   events/{id}/teamPlayers?placings=true               team standings
//   events/{id}/pairings?eventId={id}&pairingType=Pairing&round={n}      player-level games
//   events/{id}/pairings?eventId={id}&pairingType=TeamPairing&round={n}  team-level matches
// Player rows: subFaction IS the disposition, player{1,2}Game.points is the 0..20 game score.
// An empty round answers 200 with {active: []}.
//
// BCP posts a round in two steps (round 1 fixtures and live round 2, read 2026-10-17): the team
// pairings first, then each match's eight player rows at once when that match is paired, 5
// minutes to hours later. A round in which our match has no player rows yet is treated as not
// posted. A player row without a positive integer table is dropped and counted (BcpRound.dropped).
//
// A player's own `team` label is what they typed at registration, not the team they play
// for in a match (ringers, typos, undefined), so each player row is attributed to a team
// through its `teamPairingId` (player1 sits on teamPlayer1, player2 on teamPlayer2) and the
// label is only a fallback.
//
// Every GET is cached 60 s in module memory keyed by URL. Each GET (headers and body) has an
// 8 s deadline. Failures (network, timeout, non-200, bad JSON, wrong shape) reject with
// BcpError and are never cached; loadBcpSnapshot never resolves a partial snapshot.

import type { WdcPlayer, WdcRound, WdcTable, WdcTeam } from "./types";

const BCP_BASE = "https://newprod-api.bestcoastpairings.com/v1/";
const CACHE_MS = 60_000;
const TEAM_SIZE = 8;
const DEFAULT_ELO = 1400;
const FETCH_TIMEOUT_MS = 8_000;

export type BcpFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** network and timeout carry status 0; shape is a 200 whose body is not what we expect. */
export type BcpErrorKind = "network" | "timeout" | "status" | "json" | "shape";

export class BcpError extends Error {
  readonly url: string;
  readonly status: number;
  readonly kind: BcpErrorKind;
  constructor(
    message: string,
    url: string,
    status: number,
    options?: { cause?: unknown; kind?: BcpErrorKind },
  ) {
    super(message, options);
    this.name = "BcpError";
    this.url = url;
    this.status = status;
    this.kind = options?.kind ?? (status === 0 ? "network" : status === 200 ? "shape" : "status");
  }
}

// --- cache --------------------------------------------------------------------------

const cache = new Map<string, { at: number; value: Promise<unknown> }>();

export const resetBcpCacheForTests = (): void => {
  cache.clear();
};

const timeoutError = (url: string, cause?: unknown): BcpError =>
  new BcpError(`BCP did not answer within ${FETCH_TIMEOUT_MS / 1000} s: ${url}`, url, 0, {
    cause,
    kind: "timeout",
  });

const isAbort = (e: unknown): boolean =>
  e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");

/**
 * One GET with an 8 s deadline over headers and body. AbortSignal.timeout cancels the real
 * request on Workers; the timer race settles the call even when the fetch ignores the signal
 * (or the runtime has no AbortSignal.timeout), so a hung request can never hang a caller.
 */
const fetchJson = async (url: string, fetchImpl: BcpFetch): Promise<unknown> => {
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
      : undefined;
  const request = (async (): Promise<unknown> => {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { "client-id": "web-app", accept: "application/json" },
        signal,
      });
    } catch (cause) {
      if (isAbort(cause)) throw timeoutError(url, cause);
      throw new BcpError(`BCP request failed: ${url}`, url, 0, { cause, kind: "network" });
    }
    if (res.status !== 200)
      throw new BcpError(`BCP answered ${res.status}: ${url}`, url, res.status, { kind: "status" });
    try {
      return await res.json();
    } catch (cause) {
      if (isAbort(cause)) throw timeoutError(url, cause);
      throw new BcpError(`BCP sent invalid JSON: ${url}`, url, res.status, { cause, kind: "json" });
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError(url)), FETCH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([request, deadline]);
  } finally {
    clearTimeout(timer);
  }
};

const getJson = async (url: string, fetchImpl: BcpFetch): Promise<unknown> => {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = fetchJson(url, fetchImpl);
  cache.set(url, { at: Date.now(), value });
  try {
    return await value;
  } catch (err) {
    // Only drop our own failed entry (timeouts too); a newer one may already have replaced it.
    if (cache.get(url)?.value === value) cache.delete(url);
    throw err;
  }
};

// --- raw helpers --------------------------------------------------------------------

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** A table number is a positive integer; anything else (missing, 0, fractional) is no table. */
const tableNo = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && Number.isInteger(n) && n >= 1 ? n : null;
};

const activeRows = (json: unknown, url: string): Raw[] => {
  if (!isObj(json) || !Array.isArray(json.active)) {
    throw new BcpError(`BCP response has no active[] list: ${url}`, url, 200);
  }
  return json.active.filter(isObj);
};

/** Case-insensitive, whitespace-collapsed, trailing punctuation dropped: "Mandatory F.U.N" == "Mandatory F.U.N.". */
export const bcpTeamKey = (name: string): string =>
  name
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.,;:!?]+$/, "")
    .trim();

const eventUrl = (eventId: string): string => `${BCP_BASE}events/${encodeURIComponent(eventId)}`;
const roundUrl = (eventId: string, type: "Pairing" | "TeamPairing", n: number): string => {
  const id = encodeURIComponent(eventId);
  return `${BCP_BASE}events/${id}/pairings?eventId=${id}&pairingType=${type}&round=${n}`;
};

// --- normalized shapes --------------------------------------------------------------

export type BcpEvent = { id: string; name: string; where: string; rounds: number };

export type BcpStanding = {
  name: string;
  captain: string | null;
  placing: number | null;
  matchPoints: number;
  battlePoints: number;
  gameWins: number;
};

export type BcpSeat = {
  name: string;
  /** The label the player registered with; unreliable, see the file header. */
  teamLabel: string;
  faction: string;
  dispo: string;
  list: string | null;
  /** Their 0..20 game score, or null when BCP has none yet. */
  points: number | null;
};

export type BcpPairing = {
  table: number;
  published: boolean;
  isDone: boolean;
  teamPairingId: string;
  p1: BcpSeat | null;
  p2: BcpSeat | null;
};

export type BcpTeamPairing = {
  id: string;
  table: number;
  published: boolean;
  isDone: boolean;
  teamA: string;
  teamB: string | null;
  pointsA: number | null;
  pointsB: number | null;
};

export type BcpRound = {
  n: number;
  /** Player rows with a positive integer table; `table` is never 0. */
  pairings: BcpPairing[];
  teamPairings: BcpTeamPairing[];
  /** Player rows with at least one player but no usable table number, left out of `pairings`. */
  dropped: number;
};

// --- fetchers -----------------------------------------------------------------------

export const fetchBcpEvent = async (
  eventId: string,
  fetchImpl: BcpFetch = globalThis.fetch,
): Promise<BcpEvent> => {
  const url = eventUrl(eventId);
  const json = await getJson(url, fetchImpl);
  if (!isObj(json)) throw new BcpError(`BCP event is not an object: ${url}`, url, 200);
  const rounds = num(json.numberOfRounds);
  if (rounds === null || rounds < 1)
    throw new BcpError(`BCP event has no numberOfRounds: ${url}`, url, 200);
  const where = [str(json.city), str(json.state)].filter(Boolean).join(", ");
  return { id: str(json.id) || eventId, name: str(json.name), where, rounds };
};

export const fetchBcpStandings = async (
  eventId: string,
  fetchImpl: BcpFetch = globalThis.fetch,
): Promise<BcpStanding[]> => {
  const url = `${eventUrl(eventId)}/teamPlayers?placings=true`;
  const rows = activeRows(await getJson(url, fetchImpl), url);
  return rows.map((row) => {
    const metrics = new Map<string, number>();
    if (Array.isArray(row.metrics)) {
      for (const m of row.metrics) {
        if (isObj(m) && typeof m.name === "string") metrics.set(m.name, num(m.value) ?? 0);
      }
    }
    const cap = isObj(row.captain)
      ? [str(row.captain.firstName), str(row.captain.lastName)].filter(Boolean).join(" ")
      : "";
    return {
      name: str(row.name),
      captain: cap || null,
      placing: num(row.placing),
      matchPoints: metrics.get("Match Points") ?? 0,
      battlePoints: metrics.get("Battle Points") ?? 0,
      gameWins: metrics.get("Game Wins") ?? 0,
    };
  });
};

const readSeat = (raw: unknown, game: unknown): BcpSeat | null => {
  if (!isObj(raw)) return null;
  const user = isObj(raw.user) ? raw.user : {};
  const name = [str(user.firstName), str(user.lastName)].filter(Boolean).join(" ");
  // BCP fills an empty seat (the bye) with dashes in some responses and omits it in others.
  if (!name || /^[-\s]+$/.test(name)) return null;
  const g = isObj(game) ? game : {};
  return {
    name,
    teamLabel: str(raw.team),
    faction: str(raw.faction),
    dispo: str(raw.subFaction),
    list: str(raw.listId) || null,
    points: num(g.points),
  };
};

/** One round, both pairing types. A round BCP has not paired answers 200 with empty lists. */
export const fetchBcpRound = async (
  eventId: string,
  n: number,
  fetchImpl: BcpFetch = globalThis.fetch,
): Promise<BcpRound> => {
  const pUrl = roundUrl(eventId, "Pairing", n);
  const tUrl = roundUrl(eventId, "TeamPairing", n);
  const [pJson, tJson] = await Promise.all([getJson(pUrl, fetchImpl), getJson(tUrl, fetchImpl)]);
  const pairings: BcpPairing[] = [];
  let dropped = 0;
  for (const row of activeRows(pJson, pUrl)) {
    const p1 = readSeat(row.player1, row.player1Game);
    const p2 = readSeat(row.player2, row.player2Game);
    const table = tableNo(row.table);
    if (table === null) {
      // A seatless row without a table loses nothing; one with players is a game we cannot place.
      if (p1 || p2) dropped++;
      continue;
    }
    pairings.push({
      table,
      published: row.published === true,
      isDone: row.isDone === true,
      teamPairingId: str(row.teamPairingId),
      p1,
      p2,
    });
  }
  const teamPairings = activeRows(tJson, tUrl).map((row): BcpTeamPairing => {
    const a = isObj(row.teamPlayer1) ? str(row.teamPlayer1.name) : "";
    const b = isObj(row.teamPlayer2) ? str(row.teamPlayer2.name) : "";
    const g1 = isObj(row.player1Game) ? num(row.player1Game.points) : null;
    const g2 = isObj(row.player2Game) ? num(row.player2Game.points) : null;
    return {
      id: str(row.id),
      table: num(row.table) ?? 0,
      published: row.published === true,
      isDone: row.isDone === true,
      teamA: a,
      teamB: b && !/^[-\s]+$/.test(b) ? b : null,
      pointsA: g1,
      pointsB: g2,
    };
  });
  return { n, pairings, teamPairings, dropped };
};

// --- snapshot -----------------------------------------------------------------------

export type BcpSnapshot = {
  event: { id: string; name: string; where: string; rounds: number; teamSize: number };
  teams: Record<string, WdcTeam>;
  /** Our tables for every round BCP has published, in BCP table order. */
  rounds: WdcRound[];
  /** Opponent team names (standings spelling) from those rounds. */
  played: string[];
  /** Plain-text notes for the page, e.g. BCP games skipped for want of a table number. */
  warnings?: string[];
  bcpAt: string;
};

const roundIsPublished = (r: BcpRound): boolean =>
  r.pairings.some((p) => p.published) || r.teamPairings.some((t) => t.published);

export const loadBcpSnapshot = async (
  eventId: string,
  ourTeam: string,
  fetchImpl: BcpFetch = globalThis.fetch,
): Promise<BcpSnapshot> => {
  const [event, standings] = await Promise.all([
    fetchBcpEvent(eventId, fetchImpl),
    fetchBcpStandings(eventId, fetchImpl),
  ]);

  // Teams are keyed by the standings spelling.
  const teams: Record<string, WdcTeam> = {};
  const canonical = new Map<string, string>();
  for (const s of standings) {
    if (!s.name) continue;
    teams[s.name] = {
      name: s.name,
      captain: s.captain,
      placing: s.placing,
      matchPoints: s.matchPoints,
      battlePoints: s.battlePoints,
      gameWins: s.gameWins,
      players: [],
    };
    canonical.set(bcpTeamKey(s.name), s.name);
  }
  const teamName = (raw: string): string => canonical.get(bcpTeamKey(raw)) ?? raw.trim();
  const ensureTeam = (name: string): WdcTeam => {
    const have = teams[name];
    if (have) return have;
    const fresh: WdcTeam = {
      name,
      captain: null,
      placing: null,
      matchPoints: 0,
      battlePoints: 0,
      gameWins: 0,
      players: [],
    };
    teams[name] = fresh;
    canonical.set(bcpTeamKey(name), name);
    return fresh;
  };
  const ourName = teamName(ourTeam);
  const ourKey = bcpTeamKey(ourName);

  const rounds: WdcRound[] = [];
  const played: string[] = [];
  const warnings: string[] = [];

  for (let n = 1; n <= event.rounds; n++) {
    const raw = await fetchBcpRound(eventId, n, fetchImpl);
    if (!roundIsPublished(raw)) break;
    if (raw.dropped > 0) {
      const games = raw.dropped === 1 ? "1 BCP game" : `${raw.dropped} BCP games`;
      warnings.push(`Round ${n}: ${games} without a table number skipped`);
    }

    const matches = new Map<string, BcpTeamPairing>();
    for (const t of raw.teamPairings) if (t.id) matches.set(t.id, t);

    // Players, attributed to a team through their match.
    for (const row of raw.pairings) {
      const match = matches.get(row.teamPairingId);
      const seats: Array<[BcpSeat | null, string | null]> = [
        [row.p1, match ? match.teamA : null],
        [row.p2, match ? match.teamB : null],
      ];
      for (const [seat, matchTeam] of seats) {
        if (!seat) continue;
        const label = matchTeam ?? seat.teamLabel;
        if (!label) continue;
        const team = ensureTeam(teamName(label));
        const at = team.players.findIndex((p) => p.name.toLowerCase() === seat.name.toLowerCase());
        const prev = at >= 0 ? team.players[at] : undefined;
        // Later rounds win (lists and dispositions can change), but never blank a known value.
        const next: WdcPlayer = {
          name: seat.name,
          team: team.name,
          faction: seat.faction || prev?.faction || "",
          dispo: seat.dispo || prev?.dispo || "",
          elo: DEFAULT_ELO,
          eloKnown: false,
          list: seat.list ?? prev?.list ?? null,
        };
        if (at >= 0) team.players[at] = next;
        else team.players.push(next);
      }
    }

    // Our eight tables, if we played this round (a bye leaves no match).
    const ours = raw.teamPairings.find(
      (t) => t.teamB !== null && (bcpTeamKey(t.teamA) === ourKey || bcpTeamKey(t.teamB) === ourKey),
    );
    if (!ours) continue;
    const weAreA = bcpTeamKey(ours.teamA) === ourKey;
    const opp = teamName(weAreA ? (ours.teamB ?? "") : ours.teamA);
    const tables: WdcTable[] = [];
    for (const row of raw.pairings
      .filter((p) => p.teamPairingId === ours.id)
      .sort((a, b) => a.table - b.table)) {
      const mine = weAreA ? row.p1 : row.p2;
      const theirs = weAreA ? row.p2 : row.p1;
      if (!mine || !theirs) continue;
      const hasScore = mine.points !== null && (row.isDone || mine.points > 0);
      tables.push({
        t: row.table,
        us: mine.name,
        them: theirs.name,
        bcpScore: hasScore ? mine.points : null,
        coachScore: null,
        nudge: 0,
      });
    }
    // BCP posts the team pairing before the player rows; with none of our games posted yet the
    // round is not posted for us (no 0-table round, no "played" opponent, the coach's locks stay).
    if (tables.length < 1) continue;
    rounds.push({ n, opp, fromBcp: true, tables });
    if (!played.includes(opp)) played.push(opp);
  }

  return {
    event: {
      id: event.id,
      name: event.name,
      where: event.where,
      rounds: event.rounds,
      teamSize: TEAM_SIZE,
    },
    teams,
    rounds,
    played,
    warnings,
    bcpAt: new Date().toISOString(),
  };
};
