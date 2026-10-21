// State layer for the coach board. Contract: docs/CONTRACT.md (C2, C3, C5, C6).
//
// Pure merge (mergeBoard) plus the Workers KV flows the Worker wraps. Everything that touches
// storage takes the KV binding as an argument and everything that touches BCP takes an injectable
// fetch, so the whole layer runs against a fake KV in tests; src/worker/handler.ts is only the thin
// HTTP shell around loadBoard / saveCoach.
import { bcpTeamKey, loadBcpSnapshot, type BcpFetch, type BcpSnapshot } from "./bcp.server";
import { lookupElo, normalizeName, WDC_UNKNOWN_ELO, type EloSnapshot } from "./elo";
import { DEFAULT_WEIGHTS, isWeight } from "./history";
import { coachEntry, oppMatches } from "./keys";
import type {
  WdcBoardState,
  WdcCoachEntry,
  WdcCoachRound,
  WdcCoachState,
  WdcRound,
  WdcTable,
  WdcTeam,
  WdcWeights,
} from "./types";
import { WDC_GAMES } from "./types";

// --- KV keys -------------------------------------------------------------------------

export const WDC_EVENT_KEY = "wdc.event";
export const WDC_TEAM_KEY = "wdc.team";
export const WDC_PIN_KEY = "wdc.pin.sha256";
export const WDC_PIN_FAILS_KEY = "wdc.pin.fails2"; // renamed 2026-10-17 to clear a lockout caused by blank PINs
export const WDC_DEFAULT_EVENT = "JkPs5aELBHPh";
export const WDC_DEFAULT_TEAM = "Warp Dust Crusaders";
export const wdcStateKey = (eventId: string): string => `wdc.state.${eventId}`;
export const wdcSnapshotKey = (eventId: string): string => `wdc.snapshot.${eventId}`;

// --- hashing ------------------------------------------------------------------------

/** Hex SHA-256 of `text` (Web Crypto, available in Workers and Node). */
export const sha256Hex = async (text: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  let out = "";
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, "0");
  return out;
};

/** Constant-time compare of two hex strings: no early exit on the first differing character. */
export const hexEqual = (a: string, b: string): boolean => {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
};

// --- coach document -----------------------------------------------------------------

export const emptyCoach = (): WdcCoachState => ({
  rounds: {},
  pairing: { opp: "", locks: [] },
  eloOverrides: {},
});

const NAME_MAX = 120;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const isKey = (k: string): boolean => /^[0-9]{1,3}$/.test(k) && Number(k) >= 1;
const isText = (v: unknown): v is string => typeof v === "string" && v.length <= NAME_MAX;
/** A player key is a name already in normalizeName form (what the page writes), never empty. */
const isPlayerKey = (k: string): boolean =>
  k.length > 0 && k.length <= NAME_MAX && normalizeName(k) === k;

// Size caps on the coach document (t-731 D7): an event has at most a dozen rounds and a team match
// eight games (from a roster of nine at most), so anything past these is junk, refused before any
// deep validation.
export const WDC_MAX_ROUNDS = 12;
export const WDC_MAX_ROUND_PLAYERS = 16;
export const WDC_MAX_ELO_OVERRIDES = 200;

/** True when `obj` has more than `max` own keys; stops counting at max + 1. */
const overKeys = (obj: Record<string, unknown>, max: number): boolean => {
  let n = 0;
  for (const k in obj) if (Object.prototype.hasOwnProperty.call(obj, k) && ++n > max) return true;
  return false;
};

/**
 * Validates and rebuilds a coach document (C3). Returns null for anything out of shape or range:
 * at most 12 rounds of {opp?, players} with at most 16 player entries each, player keys already in
 * normalizeName form, opp a string of at most 120 characters, score null or integer 0..20, nudge
 * integer -20..20, at most eight locks of {us, them} strings, at most 200 eloOverrides of finite
 * numbers 100..3000. The count caps are checked first, so an oversized document is refused without
 * walking it. A round that carries the retired table-keyed `tables` field is refused outright
 * (t-736: a table number is not a stable key), so an old-shape document is never half read.
 * `weights` (t-739) is optional: absent stays absent (the page reads the defaults); present, it must
 * be an object whose faction, form and history are each a number 0..2 on a 0.25 step, and a missing
 * one of the three is stored as its default. Other unknown fields are dropped.
 */
export const parseCoachState = (input: unknown): WdcCoachState | null => {
  if (
    !isRecord(input) ||
    !isRecord(input.rounds) ||
    !isRecord(input.pairing) ||
    !isRecord(input.eloOverrides)
  )
    return null;

  // cheap count checks before any deep validation
  if (
    overKeys(input.rounds, WDC_MAX_ROUNDS) ||
    overKeys(input.eloOverrides, WDC_MAX_ELO_OVERRIDES) ||
    !Array.isArray(input.pairing.locks) ||
    input.pairing.locks.length > WDC_GAMES
  )
    return null;
  for (const rv of Object.values(input.rounds))
    if (
      !isRecord(rv) ||
      "tables" in rv ||
      !isRecord(rv.players) ||
      overKeys(rv.players, WDC_MAX_ROUND_PLAYERS)
    )
      return null;

  const rounds: Array<[string, WdcCoachRound]> = [];
  for (const [rk, rv] of Object.entries(input.rounds)) {
    if (!isKey(rk) || !isRecord(rv) || !isRecord(rv.players)) return null;
    if (rv.opp !== undefined && !isText(rv.opp)) return null;
    const players: Array<[string, WdcCoachEntry]> = [];
    for (const [pk, pv] of Object.entries(rv.players)) {
      if (!isPlayerKey(pk) || !isRecord(pv)) return null;
      const score = pv.score;
      if (score !== null && !isInt(score, 0, 20)) return null;
      if (!isInt(pv.nudge, -20, 20)) return null;
      players.push([pk, { score, nudge: pv.nudge }]);
    }
    const round: WdcCoachRound = { players: Object.fromEntries(players) };
    if (rv.opp) round.opp = rv.opp;
    rounds.push([rk, round]);
  }

  const { opp, locks } = input.pairing;
  if (!isText(opp) || !Array.isArray(locks) || locks.length > WDC_GAMES) return null;
  const cleanLocks: Array<{ us: string; them: string }> = [];
  for (const l of locks) {
    if (!isRecord(l) || !isText(l.us) || !isText(l.them)) return null;
    cleanLocks.push({ us: l.us, them: l.them });
  }

  const overrides = Object.entries(input.eloOverrides);
  const eloOverrides: Array<[string, number]> = [];
  for (const [name, elo] of overrides) {
    if (
      name.length > NAME_MAX ||
      typeof elo !== "number" ||
      !Number.isFinite(elo) ||
      elo < 100 ||
      elo > 3000
    )
      return null;
    eloOverrides.push([name, elo]);
  }

  let weights: WdcWeights | undefined;
  if (input.weights !== undefined) {
    const w = input.weights;
    if (!isRecord(w)) return null;
    const one = (v: unknown, fallback: number): number | null =>
      v === undefined ? fallback : isWeight(v) ? v : null;
    const faction = one(w.faction, DEFAULT_WEIGHTS.faction);
    const form = one(w.form, DEFAULT_WEIGHTS.form);
    const history = one(w.history, DEFAULT_WEIGHTS.history);
    if (faction === null || form === null || history === null) return null;
    weights = { faction, form, history };
  }

  return {
    rounds: Object.fromEntries(rounds),
    pairing: { opp, locks: cleanLocks },
    eloOverrides: Object.fromEntries(eloOverrides),
    ...(weights ? { weights } : {}),
  };
};

// --- merge --------------------------------------------------------------------------

/** What mergeBoard reads from BCP; `bcpAt` is null when there is no snapshot at all. */
export type WdcSnapshotInput = Omit<BcpSnapshot, "bcpAt"> & { bcpAt: string | null };

export type MergeOptions = { pinSet: boolean; stale: boolean; our: string };

const pickScore = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** The snapshot's spelling of our team (F8): BCP's key wins over the configured case and punctuation. */
const resolveOurTeam = (configured: string, teams: Record<string, unknown>): string => {
  if (Object.prototype.hasOwnProperty.call(teams, configured)) return configured;
  const key = bcpTeamKey(configured);
  return Object.keys(teams).find((k) => bcpTeamKey(k) === key) ?? configured;
};

/**
 * Merges the BCP snapshot (C2) with the coach document (C3) and resolves Elo (C5).
 * - bcpScore comes only from BCP; coachScore and nudge only from the coach; the page decides which score shows.
 * - Elo per player: coach override, then the Stat Check snapshot, then 1400 with eloKnown false.
 * - When the coach has locked all eight pairings for a round BCP has not published (the next one, against
 *   an opponent we have not played), that round is exposed with fromBcp false and t = lock order. Once BCP
 *   publishes it the opponent is in `played` and the BCP round replaces it.
 * - Coach entries are keyed by our player (normalizeName), never by table: every table, BCP-posted or
 *   lock-built, reads the entry of its `us` player, so a lock-built round's entries land on the same
 *   players' games when BCP posts it under other table numbers, whatever the order of saves and reads.
 *   A round whose stored `opp` is set and is not the round's opponent (oppMatches) shows none of its
 *   entries, and an entry whose player is not seated shows nowhere; neither is removed, `coach` is
 *   returned as stored, so they reappear if BCP corrects the pairing or seats the player.
 * - currentRound is the highest round in the result, including a lock-built round.
 * - `our` is the snapshot's spelling of opts.our (matched through bcpTeamKey).
 */
export const mergeBoard = (
  snapshot: WdcSnapshotInput,
  coach: WdcCoachState,
  elo: EloSnapshot,
  opts: MergeOptions,
): WdcBoardState => {
  const overrides = new Map<string, number>();
  for (const [name, value] of Object.entries(coach.eloOverrides))
    overrides.set(normalizeName(name), value);

  const teams: Record<string, WdcTeam> = {};
  for (const [key, team] of Object.entries(snapshot.teams)) {
    teams[key] = {
      ...team,
      players: team.players.map((p) => {
        const own = overrides.get(normalizeName(p.name));
        if (own !== undefined) return { ...p, elo: own, eloKnown: true };
        const hit = lookupElo(p.name, elo);
        return hit.known
          ? { ...p, elo: hit.elo, eloKnown: true }
          : { ...p, elo: WDC_UNKNOWN_ELO, eloKnown: false };
      }),
    };
  }

  /** Our player's entry in round n against `opp`; none when the round was written against another team. */
  const coachTable = (n: number, opp: string, us: string): WdcCoachEntry => {
    const key = String(n);
    const round = Object.prototype.hasOwnProperty.call(coach.rounds, key)
      ? coach.rounds[key]
      : undefined;
    const hit = round && oppMatches(round.opp, opp) ? coachEntry(round, us) : undefined;
    return { score: pickScore(hit?.score), nudge: typeof hit?.nudge === "number" ? hit.nudge : 0 };
  };

  const rounds: WdcRound[] = snapshot.rounds.map((r) => ({
    ...r,
    tables: r.tables.map((tb): WdcTable => {
      const c = coachTable(r.n, r.opp, tb.us);
      return { ...tb, bcpScore: pickScore(tb.bcpScore), coachScore: c.score, nudge: c.nudge };
    }),
  }));

  const top = rounds.reduce((m, r) => Math.max(m, r.n), 0);
  const next = top + 1;
  const locks = coach.pairing.locks;
  if (
    locks.length === WDC_GAMES &&
    !rounds.some((r) => r.n === next) &&
    (snapshot.event.rounds === 0 || next <= snapshot.event.rounds) &&
    !snapshot.played.includes(coach.pairing.opp)
  ) {
    rounds.push({
      n: next,
      opp: coach.pairing.opp,
      fromBcp: false,
      tables: locks.map((l, i): WdcTable => {
        const c = coachTable(next, coach.pairing.opp, l.us);
        return {
          t: i + 1,
          us: l.us,
          them: l.them,
          bcpScore: null,
          coachScore: c.score,
          nudge: c.nudge,
        };
      }),
    });
  }
  rounds.sort((a, b) => a.n - b.n);

  return {
    event: snapshot.event,
    our: resolveOurTeam(opts.our, snapshot.teams),
    teams,
    rounds,
    currentRound: rounds.reduce((m, r) => Math.max(m, r.n), 0),
    played: snapshot.played,
    coach,
    bcpAt: snapshot.bcpAt,
    stale: opts.stale,
    eloSource: `Elo from the Stat Check table snapshot generated ${elo.generatedAt}: ${elo.source}`,
    pinSet: opts.pinSet,
  };
};

// --- KV flows -----------------------------------------------------------------------

/**
 * The slice of the Workers KV binding this layer uses (structural, so tests hand in a fake).
 * Values are plain strings under the keys above; `get` resolves null for a missing key.
 */
export type WdcKv = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
};

// KV refuses a second write to the same key inside about one second (HTTP 429 inside the binding).
// The board's save queue can send two saves back to back, so a coach write retries a few times,
// spaced past that limit, before it counts as a failure.
export const WDC_KV_WRITE_TRIES = 3;
export const WDC_KV_RETRY_MS = 1100;

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

const readConfig = async (kv: WdcKv, key: string): Promise<string | null> => {
  const v = await kv.get(key);
  return typeof v === "string" ? v : null;
};

const writeConfig = async (
  kv: WdcKv,
  key: string,
  value: string,
  retryMs: number = WDC_KV_RETRY_MS,
  tries: number = WDC_KV_WRITE_TRIES,
): Promise<void> => {
  for (let attempt = 1; ; attempt++) {
    try {
      await kv.put(key, value);
      return;
    } catch (err) {
      if (attempt >= tries) throw err;
      await sleep(retryMs);
    }
  }
};

/** Read that never throws: a dead store must not blank the page (C2). */
const readConfigSafe = async (kv: WdcKv | null, key: string): Promise<string | null> => {
  if (!kv) return null;
  try {
    return await readConfig(kv, key);
  } catch {
    return null;
  }
};

const parseStoredCoach = (raw: string | null): WdcCoachState => {
  if (!raw) return emptyCoach();
  try {
    return parseCoachState(JSON.parse(raw)) ?? emptyCoach();
  } catch {
    return emptyCoach();
  }
};

const parseStoredSnapshot = (raw: string | null): BcpSnapshot | null => {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (
      isRecord(v) &&
      isRecord(v.event) &&
      isRecord(v.teams) &&
      Array.isArray(v.rounds) &&
      Array.isArray(v.played) &&
      typeof v.bcpAt === "string"
    )
      return v as unknown as BcpSnapshot;
  } catch {
    // fall through: a corrupt stored snapshot is the same as none
  }
  return null;
};

// KV writes are metered (the free plan allows 1,000 a day), so the last good snapshot is rewritten
// only when BCP's content changed, or every 15 minutes while it is unchanged (that keeps the "BCP
// unreachable since hh:mm" time within 15 minutes of the true last read). A tablet polling every
// 30 s and a dozen phones then cost a few writes per round, not one per poll.
export const WDC_SNAPSHOT_REFRESH_MS = 15 * 60_000;
const lastSnapshotWrite = new WeakMap<object, { body: string; at: number }>();
// The save path answers from the stored snapshot without calling BCP (t-742). A good BCP read rewrites
// that snapshot at least every WDC_SNAPSHOT_REFRESH_MS while the board is open (30 s polls, then up to
// a minute of KV propagation), so a stored snapshot older than this means no good read since: the
// save reply then says stale, as the next poll would.
export const WDC_SNAPSHOT_STALE_MS = WDC_SNAPSHOT_REFRESH_MS + 2 * 60_000;

/** The snapshot without its read time, for "did BCP's content change" compares. */
const snapshotBody = (snap: BcpSnapshot): string => JSON.stringify({ ...snap, bcpAt: "" });

const rememberSnapshot = async (
  kv: WdcKv,
  eventId: string,
  snap: BcpSnapshot,
  stored: BcpSnapshot | null,
): Promise<void> => {
  const body = snapshotBody(snap);
  const now = Date.now();
  const last = lastSnapshotWrite.get(kv);
  if (last && last.body === body && now - last.at < WDC_SNAPSHOT_REFRESH_MS) return;
  if (stored && snapshotBody(stored) === body) {
    const at = Date.parse(stored.bcpAt);
    if (Number.isFinite(at) && now - at >= 0 && now - at < WDC_SNAPSHOT_REFRESH_MS) {
      lastSnapshotWrite.set(kv, { body, at });
      return;
    }
  }
  try {
    // one try, no waiting: a page read never stalls on a rate-limited snapshot write
    await writeConfig(kv, wdcSnapshotKey(eventId), JSON.stringify(snap), 0, 1);
    lastSnapshotWrite.set(kv, { body, at: now });
  } catch {
    // Remembering the snapshot is best effort; the live read already succeeded.
  }
};

const noSnapshot = (eventId: string): WdcSnapshotInput => ({
  event: { id: eventId, name: "", where: "", rounds: 0, teamSize: WDC_GAMES },
  teams: {},
  rounds: [],
  played: [],
  bcpAt: null,
});

export type LoadDeps = {
  /** The EloSnapshot to resolve against (the generated elo-snapshot.json). */
  elo: EloSnapshot;
  fetchImpl?: BcpFetch;
  /**
   * Fallback coach PIN hash from the Worker secret WDC_PIN_SHA256, used only when KV has no
   * wdc.pin.sha256 value. Lets the PIN be set with `wrangler secret put` and nothing else.
   */
  pinHash?: string;
  /** Worker secret WDC_PIN_OFF set to "1": saves need no PIN and are not throttled (owner switch). */
  pinOff?: boolean;
  /** Wait between KV write retries (default WDC_KV_RETRY_MS); tests pass 0. */
  kvRetryMs?: number;
};

/** A usable 64-hex sha256 from the Worker secret, lower-cased; anything else is ignored. */
export const secretPinHash = (deps: Pick<LoadDeps, "pinHash">): string | null => {
  const h = deps.pinHash?.trim().toLowerCase();
  return h && /^[0-9a-f]{64}$/.test(h) ? h : null;
};

/** The hash stored in KV `wdc.pin.sha256`, trimmed and lower-cased; null when there is none. */
const storedPinHash = (raw: string | null): string | null => raw?.trim().toLowerCase() || null;

type BoardInputs = {
  coach: WdcCoachState;
  snap: WdcSnapshotInput;
  stale: boolean;
  pinSet: boolean;
  our: string;
};

/** Everything mergeBoard needs, read the way loadBoard documents. Never throws. */
const loadInputs = async (
  kv: WdcKv | null,
  deps: LoadDeps,
  opts: { storedFirst?: boolean },
): Promise<BoardInputs> => {
  const eventId = (await readConfigSafe(kv, WDC_EVENT_KEY))?.trim() || WDC_DEFAULT_EVENT;
  const our = (await readConfigSafe(kv, WDC_TEAM_KEY))?.trim() || WDC_DEFAULT_TEAM;
  const [stateRaw, pinRaw, snapRaw] = await Promise.all([
    readConfigSafe(kv, wdcStateKey(eventId)),
    readConfigSafe(kv, WDC_PIN_KEY),
    readConfigSafe(kv, wdcSnapshotKey(eventId)),
  ]);
  const coach = parseStoredCoach(stateRaw);
  const pinSet = !deps.pinOff && (storedPinHash(pinRaw) !== null || secretPinHash(deps) !== null);
  const stored = parseStoredSnapshot(snapRaw);
  const inputs = (snap: WdcSnapshotInput, stale: boolean): BoardInputs => ({
    coach,
    snap,
    stale,
    pinSet,
    our,
  });

  if (opts.storedFirst && stored) {
    const age = Date.now() - Date.parse(stored.bcpAt);
    return inputs(stored, !(Number.isFinite(age) && age < WDC_SNAPSHOT_STALE_MS));
  }

  try {
    const live = await loadBcpSnapshot(eventId, our, deps.fetchImpl);
    if (kv) await rememberSnapshot(kv, eventId, live, stored);
    return inputs(live, false);
  } catch {
    return inputs(stored ?? noSnapshot(eventId), true);
  }
};

/**
 * The merged board. Tries BCP (cached 60 s inside bcp.server) and remembers the result; on any
 * failure serves the stored snapshot with stale true, and with nothing stored a minimal state.
 * Never throws. `storedFirst` (the save path) answers from a stored snapshot of any age without
 * calling BCP, stale only past WDC_SNAPSHOT_STALE_MS; BCP is called only when nothing is stored.
 */
export const loadBoard = async (
  kv: WdcKv | null,
  deps: LoadDeps,
  opts: { storedFirst?: boolean } = {},
): Promise<WdcBoardState> => {
  const i = await loadInputs(kv, deps, opts);
  return mergeBoard(i.snap, i.coach, deps.elo, { pinSet: i.pinSet, stale: i.stale, our: i.our });
};

export type SaveResult =
  | { ok: true; state: WdcBoardState }
  | { ok: false; reason: "pin" | "pin-unset" | "invalid" | "unavailable"; message: string };

/** Largest save input accepted, measured as UTF-8 JSON; a full valid document with ASCII names is under 40 KB. */
export const WDC_SAVE_MAX_BYTES = 64 * 1024;

export type SaveInputCheck =
  | { ok: true; input: { coach: Record<string, unknown>; pin: string } }
  | { ok: false; reason: "invalid"; message: string };

/**
 * Shape and size check on the raw save input (the Worker's first step on POST /api/save, and the
 * first step of saveCoach): an object with a coach object and a string pin, at most 64 KB as JSON.
 * Never throws, so a junk request answers {ok: false, reason: "invalid"} instead of a 500.
 */
export const checkSaveInput = (input: unknown): SaveInputCheck => {
  const invalid = (message: string): SaveInputCheck => ({ ok: false, reason: "invalid", message });
  if (!isRecord(input) || !isRecord(input.coach) || typeof input.pin !== "string")
    return invalid("Invalid coach document");
  let bytes: number;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(input)).length;
  } catch {
    return invalid("Invalid coach document");
  }
  if (bytes > WDC_SAVE_MAX_BYTES) return invalid("Coach document too large");
  return { ok: true, input: { coach: input.coach, pin: input.pin } };
};

// Brute-force throttle on the coach PIN (C3): a 4-digit PIN is guessable through the public save
// endpoint, so 10 wrong PINs inside one 10-minute window lock every request, correct PIN included,
// until the window (which opens at the first wrong PIN) ends. Stored as JSON {count, windowStart}
// in KV key wdc.pin.fails2; the PIN and its hash are never written there.
//
// BEST EFFORT, and weaker than an atomic counter. Workers KV has no compare-and-set and no
// increment, so the counter is a plain read, then a write:
// - Requests that race (a parallel burst) all read the same count, all get their PIN compared,
//   and each writes the same count + 1; a burst of N guesses can cost only one count.
// - KV is eventually consistent between Cloudflare locations (up to about 60 s), so guesses sent
//   through different locations each see their own, lower, count.
// - KV allows about one write per second to one key; a miss whose counter write is still refused
//   after the retries answers "Too many tries" (fail closed) instead of "Wrong PIN".
// Sequential guesses from one place are throttled as designed. The PIN is compared BEFORE a miss
// is counted, so a correct PIN writes the counter only to clear earlier misses: the coach's own
// saves never pile up attempts and never meet the one-write-per-second limit on the counter. A
// strict limit needs a Durable Object or a Cloudflare rate-limiting rule on POST /api/save
// (README.md, "PIN throttle").
export const WDC_PIN_MAX_FAILS = 10;
export const WDC_PIN_WINDOW_MS = 10 * 60_000;

type PinCounter = { count: number; windowStart: number };

const isLiveCounter = (v: unknown, now: number): v is PinCounter =>
  isRecord(v) &&
  typeof v.count === "number" &&
  Number.isInteger(v.count) &&
  v.count > 0 &&
  typeof v.windowStart === "number" &&
  Number.isFinite(v.windowStart) &&
  now - v.windowStart < WDC_PIN_WINDOW_MS;

/** Live counter for `now`, or null when nothing is stored, the value is corrupt, or the window ended. */
const readPinFails = async (kv: WdcKv, now: number): Promise<PinCounter | null> => {
  const raw = await readConfig(kv, WDC_PIN_FAILS_KEY);
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (isLiveCounter(v, now)) return { count: v.count, windowStart: v.windowStart };
  } catch {
    // a corrupt counter is the same as none
  }
  return null;
};

/**
 * PIN-gated replace of the coach document (C3). Order: parse, storage, throttle, PIN, then the write.
 * The reply is merged after the write from the stored snapshot, whatever its age, so a BCP outage
 * never stalls a save; BCP is called only when no snapshot is stored at all (the 30 s poll refreshes
 * from BCP).
 */
export const saveCoach = async (
  kv: WdcKv | null,
  input: unknown,
  deps: LoadDeps,
): Promise<SaveResult> => {
  const checked = checkSaveInput(input);
  if (!checked.ok) return checked;
  const coach = parseCoachState(checked.input.coach);
  if (!coach || checked.input.pin.length > 64)
    return { ok: false, reason: "invalid", message: "Invalid coach document" };
  if (!kv) return { ok: false, reason: "unavailable", message: "Board storage is not available" };
  // the tablet trims what the coach types
  const pin = checked.input.pin.trim();
  const retryMs = deps.kvRetryMs;

  try {
    const now = Date.now();
    if (!deps.pinOff) {
      const fails = await readPinFails(kv, now);
      // locked requests stop here and write nothing
      if (fails && fails.count >= WDC_PIN_MAX_FAILS)
        return { ok: false, reason: "unavailable", message: "Too many tries" };

      const stored = storedPinHash(await readConfig(kv, WDC_PIN_KEY)) ?? secretPinHash(deps);
      if (!stored) return { ok: false, reason: "pin-unset", message: "Coach PIN not set" };
      // a blank PIN is a tablet that has not asked yet, not a guess: never counted
      if (!pin) return { ok: false, reason: "pin", message: "Enter the coach PIN" };
      // phone keyboards capitalise the first letter: the lower-cased PIN also matches (one attempt)
      const lower = pin.toLowerCase();
      const matches =
        hexEqual(await sha256Hex(pin), stored) ||
        (lower !== pin && hexEqual(await sha256Hex(lower), stored));
      if (!matches) {
        const next: PinCounter = fails
          ? { count: fails.count + 1, windowStart: fails.windowStart }
          : { count: 1, windowStart: now };
        try {
          await writeConfig(kv, WDC_PIN_FAILS_KEY, JSON.stringify(next), retryMs);
        } catch {
          // an uncounted miss must not become a free guess: fail closed
          return { ok: false, reason: "unavailable", message: "Too many tries" };
        }
        return { ok: false, reason: "pin", message: "Wrong PIN" };
      }
      // a correct PIN clears earlier misses; with none live there is nothing to write
      if (fails) {
        try {
          await writeConfig(
            kv,
            WDC_PIN_FAILS_KEY,
            JSON.stringify({ count: 0, windowStart: now }),
            retryMs,
          );
        } catch {
          // best effort: the misses then expire with their window
        }
      }
    }

    const eventId = (await readConfig(kv, WDC_EVENT_KEY))?.trim() || WDC_DEFAULT_EVENT;
    // Stored as sent: entries are keyed by player, so no BCP snapshot (however old) rewrites them.
    await writeConfig(kv, wdcStateKey(eventId), JSON.stringify(coach), retryMs);
  } catch {
    return { ok: false, reason: "unavailable", message: "Save failed: storage error" };
  }

  // never throws; the merge below uses the document just written, not the stored read
  const board = await loadInputs(kv, deps, { storedFirst: true });
  const state = mergeBoard(board.snap, coach, deps.elo, {
    pinSet: !deps.pinOff,
    stale: board.stale,
    our: board.our,
  });
  return { ok: true, state };
};
