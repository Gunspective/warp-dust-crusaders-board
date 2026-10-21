// Builds src/lib/wdc/player-history-snapshot.json for the coach board (docs/HISTORY.md: player history weights).
// Run from the repo root:  node scripts/bcp-history.mjs [--event <id>] [--days 365] [--edition YYYY-MM-DD] [--fresh] [--cache <dir>]
// (Node 22.18+ or Bun: the TypeScript helpers it imports are type-strippable.)
//
// Source: BCP's public API (header client-id: web-app, no login, no credentials sent).
// 1. Roster: events/{id}/pairings?pairingType=Pairing for every round that answers; each seat carries user.id and a display name.
// 2. Per user: players?userId=...&sortAscending=false (newest first, paged by nextKey) lists their event entries. Paging stops
//    once an entry was created more than 180 days before the window (registrations precede events by weeks to months).
// 3. Per eventId: events/{id} gives eventDate and gameSystemId; only Warhammer 40,000 (WGMSzfKFYA) dated in the window stays.
// 4. Per kept entry: players/{eventPlayerId}/pairings; src/lib/wdc/history-aggregate.ts turns the rows into games
//    (result 2 win, 1 draw, 0 loss; byes and unfinished rows skipped) and records.
// editionStart is read from the data: the earliest 40K event in the window where an entry carries one of the dispositions
// (subFaction) the TEO-8 roster plays; --edition overrides it, and 2026-06-01 is used when the evidence is ambiguous.
// At most 4 requests in flight; 429/5xx retried twice with backoff. Raw responses are cached on disk (except the current
// event's own pairings, which change between rounds) so a rerun is fast; --fresh ignores the cache.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const libDir = path.join(repoRoot, 'src', 'lib', 'wdc');
const outPath = path.join(libDir, 'player-history-snapshot.json');
const { normalizeName } = await import(pathToFileURL(path.join(libDir, 'elo.ts')).href);
const { factionKey, resolveFaction } = await import(pathToFileURL(path.join(libDir, 'matchups.ts')).href);
const { gamesFromPairings, aggregateHistory, bcpName } = await import(
  pathToFileURL(path.join(libDir, 'history-aggregate.ts')).href
);
const matchupSnapshot = JSON.parse(fs.readFileSync(path.join(libDir, 'matchup-snapshot.json'), 'utf8'));

const args = process.argv.slice(2);
const argVal = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const EVENT_ID = argVal('--event', 'JkPs5aELBHPh');
const DAYS = Number(argVal('--days', '365'));
// Owner 2026-10-18: 11th edition started at ATC Tennessee (Chattanooga, eventDate 2026-06-26).
// That is the default; --edition overrides it, and --edition auto reads it from the data as before.
const EDITION_ARG = argVal('--edition', '2026-06-26');
const EDITION_OVERRIDE = EDITION_ARG === 'auto' ? null : EDITION_ARG;
const FRESH = args.includes('--fresh');
// Raw BCP replies are cached under scripts/.cache (git-ignored) unless --cache names another folder.
const CACHE_DIR = argVal('--cache', path.join(repoRoot, 'scripts', '.cache', 'bcp-history'));
const BASE = 'https://newprod-api.bestcoastpairings.com/v1/';
const GAME_SYSTEM_40K = 'WGMSzfKFYA';
const EDITION_FALLBACK = '2026-06-01';
const REGISTRATION_LEAD_DAYS = 180;
const MAX_ROUND = 12;
const CONCURRENCY = 4;
const TIMEOUT_MS = 20_000;

const generatedAt = new Date();
const day = (d) => d.toISOString().slice(0, 10);
const windowStart = day(new Date(generatedAt.getTime() - DAYS * 86400_000));
const today = day(generatedAt);
const pageFloor = day(new Date(generatedAt.getTime() - (DAYS + REGISTRATION_LEAD_DAYS) * 86400_000));

// ---------- polite GET: pool of 4, retries, disk cache ----------
fs.mkdirSync(CACHE_DIR, { recursive: true });
const stats = { requests: 0, cached: 0, retries: 0, failed: 0 };
let active = 0;
const queue = [];
const acquire = () =>
  new Promise((resolve) => {
    if (active < CONCURRENCY) {
      active++;
      resolve();
    } else queue.push(resolve);
  });
const release = () => {
  const next = queue.shift();
  if (next) next();
  else active--;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(rel, { cache = true } = {}) {
  const url = BASE + rel;
  const file = path.join(CACHE_DIR, crypto.createHash('sha1').update(url).digest('hex') + '.json');
  if (cache && !FRESH && fs.existsSync(file)) {
    stats.cached++;
    return JSON.parse(fs.readFileSync(file, 'utf8')).body;
  }
  await acquire();
  try {
    for (let attempt = 0; ; attempt++) {
      stats.requests++;
      let status = 0;
      try {
        const res = await fetch(url, {
          headers: { 'client-id': 'web-app', accept: 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        status = res.status;
        if (res.ok) {
          const body = await res.json();
          if (cache) fs.writeFileSync(file, JSON.stringify({ url, at: new Date().toISOString(), body }));
          return body;
        }
        if (status !== 429 && status < 500) {
          // A 4xx other than 429 is BCP's answer (a deleted event answers 404), so it is cached like a body.
          stats.failed++;
          if (cache) fs.writeFileSync(file, JSON.stringify({ url, at: new Date().toISOString(), body: { __status: status } }));
          return { __status: status };
        }
        if (attempt >= 2) throw new Error(`BCP answered ${status} after 3 tries: ${url}`);
        const after = Number(res.headers.get('retry-after'));
        stats.retries++;
        await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 1500 * 3 ** attempt);
      } catch (e) {
        if (status !== 0 || attempt >= 2) {
          stats.failed++;
          throw e;
        }
        stats.retries++;
        await sleep(1500 * 3 ** attempt);
      }
    }
  } finally {
    release();
  }
}

const fold = (name) => resolveFaction(matchupSnapshot, name) ?? factionKey(name);

// ---------- 1. roster ----------
const roster = new Map(); // userId -> { name, key, faction, dispo }
const teo8Dispos = new Set();
for (let round = 1; round <= MAX_ROUND; round++) {
  const rel = `events/${EVENT_ID}/pairings?eventId=${EVENT_ID}&pairingType=Pairing&round=${round}`;
  const json = await getJson(rel, { cache: false });
  const rows = Array.isArray(json?.active) ? json.active : [];
  if (rows.length === 0) {
    if (round === 1) throw new Error(`BCP round 1 of ${EVENT_ID} returned no pairings`);
    break;
  }
  for (const r of rows) {
    for (const p of [r.player1, r.player2]) {
      const u = p?.user;
      if (!u?.id) continue;
      const display = `${u.firstName ?? ''} ${u.lastName ?? ''}`.replace(/\s+/g, ' ').trim();
      if (!display || /^[-\s]+$/.test(display)) continue;
      const dispo = bcpName(p.subFaction);
      if (dispo) teo8Dispos.add(dispo);
      // Later rounds win, as on the board.
      roster.set(u.id, { name: display, key: normalizeName(display), faction: bcpName(p.faction), dispo });
    }
  }
}
const keyCount = new Map();
for (const r of roster.values()) keyCount.set(r.key, (keyCount.get(r.key) ?? 0) + 1);
const clashes = [...keyCount].filter(([, n]) => n > 1).map(([k]) => k);
console.log(`roster: ${roster.size} players on ${EVENT_ID}; TEO-8 dispositions: ${[...teo8Dispos].sort().join(', ')}`);
if (clashes.length) console.log(`  WARNING: normalized names shared by two users (later one wins): ${clashes.join(', ')}`);

// ---------- 2. entries ----------
async function entriesFor(userId) {
  const out = [];
  let nextKey = null;
  for (let page = 0; page < 20; page++) {
    const rel =
      `players?userId=${encodeURIComponent(userId)}&limit=50&sortAscending=false` +
      (nextKey ? `&nextKey=${encodeURIComponent(nextKey)}` : '');
    const json = await getJson(rel);
    const data = Array.isArray(json?.data) ? json.data : [];
    out.push(...data);
    nextKey = typeof json?.nextKey === 'string' && json.nextKey ? json.nextKey : null;
    const oldest = data.length ? String(data[data.length - 1].created_at ?? '').slice(0, 10) : '';
    if (!nextKey || data.length === 0 || (oldest && oldest < pageFloor)) break;
  }
  return out.filter((e) => String(e.created_at ?? '').slice(0, 10) >= pageFloor);
}

const users = [...roster.keys()];
const entriesByUser = new Map(
  await Promise.all(users.map(async (u) => [u, await entriesFor(u)])),
);

// ---------- 3. events ----------
const eventIds = new Set();
for (const list of entriesByUser.values()) for (const e of list) if (e.eventId) eventIds.add(e.eventId);
const events = new Map();
await Promise.all(
  [...eventIds].map(async (id) => {
    const json = await getJson(`events/${encodeURIComponent(id)}`);
    if (json && !json.__status) {
      events.set(id, {
        date: String(json.eventDate ?? '').slice(0, 10),
        system: json.gameSystemId ?? '',
        systemName: json.gameSystemName ?? '',
        name: String(json.name ?? '').trim(),
      });
    }
  }),
);

// ---------- 4. pairings ----------
const kept = []; // { userId, entry, event }
let skippedNo40k = 0;
let skippedNoEvent = 0;
let skippedWindow = 0;
for (const [userId, list] of entriesByUser) {
  for (const entry of list) {
    const ev = entry.eventId ? events.get(entry.eventId) : null;
    if (!ev) {
      skippedNoEvent++;
      continue;
    }
    if (ev.system !== GAME_SYSTEM_40K) {
      skippedNo40k++;
      continue;
    }
    if (!ev.date || ev.date < windowStart || ev.date > today) {
      skippedWindow++;
      continue;
    }
    kept.push({ userId, entry, event: ev });
  }
}
const gamesByUser = new Map(users.map((u) => [u, []]));
const tally = { byes: 0, unfinished: 0, mismatched: 0, entriesNoGames: 0 };
const ed11Evidence = []; // { date, eventId, name, dispo, user }
await Promise.all(
  kept.map(async ({ userId, entry, event }) => {
    const rows = await getJson(`players/${encodeURIComponent(entry.id)}/pairings`, {
      cache: entry.eventId !== EVENT_ID,
    });
    const t = gamesFromPairings(Array.isArray(rows) ? rows : [], {
      eventPlayerId: entry.id,
      date: event.date,
      fold,
      fallbackFaction: bcpName(entry.faction),
      fallbackDispo: bcpName(entry.subFaction),
    });
    tally.byes += t.byes;
    tally.unfinished += t.unfinished;
    tally.mismatched += t.mismatched;
    if (t.games.length === 0) tally.entriesNoGames++;
    gamesByUser.get(userId).push(...t.games);
    const dispo = bcpName(entry.subFaction) || t.games.find((g) => g.myDispo)?.myDispo || '';
    if (teo8Dispos.has(dispo)) {
      ed11Evidence.push({ date: event.date, eventId: entry.eventId, name: event.name, dispo, user: roster.get(userId).name, games: t.games.length });
    }
  }),
);

// ---------- editionStart ----------
// Earliest 40K event in the window with a TEO-8 disposition on an entry. Ambiguous when that first date stands alone: no
// second such event within 14 days after it, or 40K entries before it already carry some other subFaction value.
ed11Evidence.sort((a, b) => a.date.localeCompare(b.date));
const plus14 = (d) => day(new Date(new Date(d + 'T00:00:00Z').getTime() + 14 * 86400_000));
let editionStart;
let editionNote;
if (EDITION_OVERRIDE) {
  editionStart = EDITION_OVERRIDE;
  editionNote = `--edition ${EDITION_OVERRIDE} given on the command line`;
} else if (ed11Evidence.length === 0) {
  editionStart = EDITION_FALLBACK;
  editionNote = `no 40K entry in the window carries a TEO-8 disposition; ambiguous, using ${EDITION_FALLBACK}`;
} else {
  const first = ed11Evidence[0].date;
  const nearby = new Set(ed11Evidence.filter((e) => e.date <= plus14(first)).map((e) => e.eventId));
  if (nearby.size >= 2) {
    editionStart = first;
    editionNote = `earliest TEO-8 disposition on ${first}; ${nearby.size} distinct events carry one by ${plus14(first)}`;
  } else {
    editionStart = EDITION_FALLBACK;
    editionNote = `earliest TEO-8 disposition on ${first} stands alone (one event within 14 days); ambiguous, using ${EDITION_FALLBACK}`;
  }
}
const before = new Map(); // subFaction value on 40K entries dated before editionStart -> count
let beforeEntries = 0;
for (const { entry, event } of kept) {
  if (event.date >= editionStart) continue;
  beforeEntries++;
  const s = bcpName(entry.subFaction);
  if (s) before.set(s, (before.get(s) ?? 0) + 1);
}
const byWeek = new Map(); // ISO week start -> [entries with a TEO-8 dispo, all 40K entries]
for (const { entry, event } of kept) {
  const d = new Date(event.date + 'T00:00:00Z');
  const wk = day(new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400_000));
  const cell = byWeek.get(wk) ?? [0, 0];
  cell[1]++;
  if (teo8Dispos.has(bcpName(entry.subFaction))) cell[0]++;
  byWeek.set(wk, cell);
}

// ---------- aggregate + write ----------
const players = {};
let totalGames = 0;
let totalEd11 = 0;
const zero = [];
for (const [userId, r] of [...roster].sort((a, b) => a[1].key.localeCompare(b[1].key))) {
  const h = aggregateHistory(r.name, gamesByUser.get(userId), { windowStart, editionStart, through: today });
  players[r.key] = h;
  totalGames += h.year.g;
  totalEd11 += h.ed11.g;
  if (h.year.g === 0) zero.push(r.name);
}
const snapshot = {
  generatedAt: generatedAt.toISOString(),
  eventId: EVENT_ID,
  windowStart,
  editionStart,
  players,
};
// One player per line: readable diffs at a fraction of the pretty-printed size.
const head = Object.entries(snapshot)
  .filter(([k]) => k !== 'players')
  .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
const body = Object.entries(players).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
const text = `{\n${head.join('\n')}\n  "players": {\n${body.join(',\n')}\n  }\n}\n`;
JSON.parse(text);
fs.writeFileSync(outPath, text);

console.log(
  `entries: ${[...entriesByUser.values()].reduce((s, l) => s + l.length, 0)} since ${pageFloor}; ${events.size}/${eventIds.size} events read (the rest answered 4xx: deleted on BCP); ` +
    `${kept.length} 40K entries in ${windowStart}..${today} (skipped ${skippedNo40k} other systems, ${skippedWindow} outside the window, ${skippedNoEvent} without a readable event)`,
);
console.log(
  `games: ${totalGames} player-games in the window, ${totalEd11} on/after editionStart; ${tally.byes} byes, ${tally.unfinished} unfinished rows skipped, ` +
    `${tally.mismatched} rows whose two result codes do not pair, ${tally.entriesNoGames} 40K entries with no finished game`,
);
console.log(`editionStart ${editionStart}: ${editionNote}`);
console.log('  first TEO-8 dispositions seen (date, event, player, disposition, games):');
for (const e of ed11Evidence.slice(0, 8)) console.log(`    ${e.date}  ${e.name} (${e.eventId})  ${e.user}  ${e.dispo}  ${e.games}`);
console.log(
  `  40K entries before ${editionStart}: ${beforeEntries}; subFaction values on them: ` +
    ([...before].map(([s, n]) => `${s} x${n}`).join(', ') || 'none'),
);
console.log('  per week (week of, entries with a TEO-8 disposition / 40K entries):');
for (const [wk, [a, b]] of [...byWeek].sort(([x], [y]) => x.localeCompare(y))) console.log(`    ${wk}  ${a}/${b}`);
console.log(`players: ${Object.keys(players).length}/${roster.size} written, ${zero.length} with no 40K game in the window${zero.length ? ': ' + zero.join(', ') : ''}`);
console.log(
  `wrote ${path.relative(repoRoot, outPath)}: ${Buffer.byteLength(text)} bytes, ${zlib.gzipSync(text).length} gzip; ` +
    `requests ${stats.requests} (${stats.retries} retries, ${stats.failed} failed), ${stats.cached} from cache`,
);
