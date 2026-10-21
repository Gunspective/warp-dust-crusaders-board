// Elo lookup for the coach board (contract C5): the Stat Check table snapshot, matched by name.
// Order: exact normalized match, then same last name + a first name that is a prefix of the other (3+ shared letters;
// sam/samuel yes, aaron/ash no) only when exactly one table name fits, otherwise unknown (1400, known false). The snapshot is produced by scripts/statcheck-elo.mjs.
// A name the generator dropped (snapshot.misses) never takes the fuzzy step again: the runtime must not resurrect a match the generator refused.

export const WDC_UNKNOWN_ELO = 1400;

export type EloMiss = { name: string; reason: string };

/** Shape of src/lib/wdc/elo-snapshot.json. `players` is keyed by the normalized BCP roster name. */
export type EloSnapshot = {
  generatedAt: string;
  source: string;
  players: Record<string, number>;
  misses: EloMiss[];
};

export type EloLookup = { elo: number; known: boolean; matchedAs?: string };

/** Lowercase, trim, collapse whitespace, strip punctuation (letters, digits and spaces survive; accents are folded). */
export const normalizeName = (name: string): string =>
  name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();

/** First and last name of an already-normalized name, or null when it cannot support a fallback match. */
const firstLast = (normalized: string): { first: string; last: string } | null => {
  const parts = normalized.split(" ");
  if (parts.length < 2) return null;
  return { first: parts[0], last: parts[parts.length - 1] };
};

/** Fewest letters two first names must share (as a prefix of the longer) for the fallback match. */
const MIN_SHARED_FIRST_NAME = 3;

/** One first name is a prefix of the other and the shorter has 3+ letters: sam/samuel yes; cj/christian, aaron/ash, vinny/vinicius no. */
export const firstNamesCompatible = (a: string, b: string): boolean => {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= MIN_SHARED_FIRST_NAME && long.startsWith(short);
};

/**
 * Only a full first and last name identifies a person: "Butters s", "A. Lee" and "dylan 40k" are display handles,
 * so they stay unknown even when the table happens to carry the same string (C5, never guessed).
 */
export const isFullName = (normalized: string): boolean => {
  const parts = normalized.split(" ");
  if (parts.length < 2) return false;
  return parts[0].length >= 2 && /^\p{L}{2,}$/u.test(parts[parts.length - 1]);
};

/**
 * Core matcher over any normalized-name -> Elo map (the full Stat Check table in the pull script, the snapshot in the app).
 * `misses` are names the generator dropped (EloMiss rows or bare names): an exact hit still wins, but they skip the fuzzy fallback.
 */
export const lookupEloIn = (
  name: string,
  players: Record<string, number>,
  misses?: ReadonlyArray<EloMiss | string>,
): EloLookup => {
  const key = normalizeName(name);
  if (!isFullName(key)) return { elo: WDC_UNKNOWN_ELO, known: false };

  const exact = players[key];
  if (typeof exact === "number" && Number.isFinite(exact))
    return { elo: exact, known: true, matchedAs: key };

  if (misses?.some((m) => normalizeName(typeof m === "string" ? m : m.name) === key))
    return { elo: WDC_UNKNOWN_ELO, known: false }; // dropped by the generator (ambiguous or unmatched): never re-derived

  const want = firstLast(key);
  if (!want) return { elo: WDC_UNKNOWN_ELO, known: false };

  let hit: string | null = null;
  for (const candidate of Object.keys(players)) {
    const got = isFullName(candidate) ? firstLast(candidate) : null;
    if (!got || got.last !== want.last || !firstNamesCompatible(got.first, want.first)) continue;
    if (hit !== null) return { elo: WDC_UNKNOWN_ELO, known: false }; // ambiguous: never guess
    hit = candidate;
  }
  if (hit === null) return { elo: WDC_UNKNOWN_ELO, known: false };
  return { elo: players[hit], known: true, matchedAs: hit };
};

export const lookupElo = (
  name: string,
  snapshot: Pick<EloSnapshot, "players"> & Partial<Pick<EloSnapshot, "misses">>,
): EloLookup => lookupEloIn(name, snapshot.players, snapshot.misses);
