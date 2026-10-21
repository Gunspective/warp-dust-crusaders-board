// Builds src/lib/wdc/elo-snapshot.json for the coach board (contract C5, C5a).
// Run from the repo root:  node scripts/statcheck-elo.mjs [--tsv <June-export.tsv>] [--event <id>] [--rounds <n>]
//
// 1. Rosters: public BCP pairings endpoint (client-id: web-app, no login), round 1 plus any later round that answers.
// 2. Elo table: Stat Check's embedded OneDrive workbook. A headless Playwright page opens the embed; the page's own
//    share lookup (my.microsoftpersonalcontent.com .../_api/v2.0/shares/...) returns the file's pre-authorized download
//    URL, which is fetched here and read as xlsx (Sheet1, Name + Elo columns). No token or cookie is ever logged or saved.
//    --tsv skips the pull and reads a Stat Check TSV export instead (the June fallback).
// 3. Each roster name goes through lookupEloIn (exact, then same last name + first-name prefix of 3+ letters when unique); the snapshot keeps only roster players.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const outPath = path.join(repoRoot, 'src', 'lib', 'wdc', 'elo-snapshot.json');
const { normalizeName, lookupEloIn, isFullName } = await import(
  pathToFileURL(path.join(repoRoot, 'src', 'lib', 'wdc', 'elo.ts')).href
);

const args = process.argv.slice(2);
const argVal = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const EVENT_ID = argVal('--event', 'JkPs5aELBHPh');
const MAX_ROUND = Number(argVal('--rounds', '8'));
const TSV_PATH = argVal('--tsv', null);
const EMBED_URL =
  "https://1drv.ms/x/c/9f33f29504402fa1/IQSM-tN0M6OcTaaLY3OtMA2vAYx131Ze6y5N0aHYpoCCJ1g?Item='Sheet1'!A1%3AL45938&wdHideGridlines=True";

// ---------- rosters ----------
async function fetchRoster() {
  const names = new Map(); // normalized -> display name
  for (let round = 1; round <= MAX_ROUND; round++) {
    const url = `https://newprod-api.bestcoastpairings.com/v1/events/${EVENT_ID}/pairings?eventId=${EVENT_ID}&pairingType=Pairing&round=${round}`;
    let json;
    try {
      const res = await fetch(url, { headers: { 'client-id': 'web-app' } });
      if (!res.ok) {
        if (round === 1) throw new Error(`BCP round 1 answered ${res.status}`);
        break;
      }
      json = await res.json();
    } catch (e) {
      if (round === 1) throw e;
      break;
    }
    const rows = Array.isArray(json?.active) ? json.active : Array.isArray(json) ? json : [];
    if (rows.length === 0) {
      if (round === 1) throw new Error('BCP round 1 returned no pairings');
      break;
    }
    for (const r of rows) {
      for (const p of [r.player1, r.player2]) {
        const u = p?.user;
        if (!u) continue;
        const display = `${u.firstName ?? ''} ${u.lastName ?? ''}`.replace(/\s+/g, ' ').trim();
        const key = normalizeName(display);
        if (key && !names.has(key)) names.set(key, display);
      }
    }
  }
  return [...names.values()];
}

// ---------- xlsx reading (zip central directory + inflate; no dependencies) ----------
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const raw = buf.slice(dataStart, dataStart + csize);
    files.set(name, () => (method === 0 ? raw : zlib.inflateRawSync(raw)).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const decodeXml = (s) =>
  s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const colIndex = (ref) => {
  let n = 0;
  for (const ch of ref.replace(/[0-9]/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
};

function parseWorkbook(buf) {
  const zip = readZip(buf);
  const read = (n) => {
    const f = zip.get(n);
    if (!f) throw new Error(`xlsx is missing ${n}`);
    return f();
  };
  const shared = [];
  for (const m of read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let text = '';
    for (const t of m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) text += t[1];
    shared.push(decodeXml(text));
  }
  const sheet = read('xl/worksheets/sheet1.xml');
  const rows = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      if (!ref) continue;
      const type = /\bt="(\w+)"/.exec(attrs)?.[1];
      const v = cm[2] ? /<v>([\s\S]*?)<\/v>/.exec(cm[2])?.[1] : undefined;
      let value = null;
      if (v !== undefined) value = type === 's' ? shared[Number(v)] : type === 'str' ? decodeXml(v) : Number(v);
      cells[colIndex(ref) - 1] = value;
    }
    rows.push(cells);
  }
  const core = zip.get('docProps/core.xml')?.() ?? '';
  const modified = /<dcterms:modified[^>]*>([^<]+)</.exec(core)?.[1] ?? null;
  return { rows, modified };
}

function tableFromRows(rows) {
  const header = (rows[0] ?? []).map((h) => (typeof h === 'string' ? h.trim().toLowerCase() : ''));
  const nameCol = header.indexOf('name');
  const eloCol = header.indexOf('elo');
  const eventCol = header.indexOf('last event');
  const countryCol = header.indexOf('country');
  if (nameCol < 0 || eloCol < 0) throw new Error(`Name/Elo columns not found in header: ${header.join(',')}`);
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const name = rows[i][nameCol];
    const elo = Number(rows[i][eloCol]);
    if (typeof name === 'string' && name.trim() && Number.isFinite(elo)) {
      out.push({ name: name.trim(), elo, lastEvent: rows[i][eventCol] ?? '', country: rows[i][countryCol] ?? '' });
    }
  }
  return out;
}

// ---------- pulls ----------
async function loadPlaywright() {
  const candidates = [];
  try {
    candidates.push(execSync('npm root -g', { encoding: 'utf8' }).trim());
  } catch {
    // fall through
  }
  candidates.push(path.join(process.env.APPDATA ?? '', 'npm', 'node_modules'));
  for (const root of candidates) {
    try {
      return createRequire(path.join(root, 'x.js'))('playwright');
    } catch {
      // try next
    }
  }
  return createRequire(import.meta.url)('playwright');
}

async function pullWorkbook() {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    let item = null;
    page.on('response', async (r) => {
      if (!item && r.request().method() === 'POST' && r.url().includes('/_api/v2.0/shares/')) {
        try {
          item = await r.json();
        } catch {
          // ignore
        }
      }
    });
    await page.goto(EMBED_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    for (let i = 0; i < 90 && !item; i++) await page.waitForTimeout(500);
    const dl = item?.['@content.downloadUrl'];
    if (!dl) throw new Error('the embed never returned a download URL');
    const res = await fetch(dl);
    if (!res.ok) throw new Error(`workbook download answered ${res.status}`);
    return { buf: Buffer.from(await res.arrayBuffer()), fileName: item.name ?? 'workbook.xlsx' };
  } finally {
    await browser.close();
  }
}

function readTsv(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const head = lines[0].split('\t').map((h) => h.trim().toLowerCase());
  const nameCol = head.indexOf('name');
  const eloCol = head.indexOf('elo');
  const eventCol = head.indexOf('last event');
  const countryCol = head.indexOf('country');
  if (nameCol < 0 || eloCol < 0) throw new Error('TSV needs Name and Elo columns');
  const out = [];
  for (const line of lines.slice(1)) {
    const c = line.split('\t');
    const elo = Number(c[eloCol]);
    if (c[nameCol] && Number.isFinite(elo)) {
      out.push({ name: c[nameCol].trim(), elo, lastEvent: c[eventCol] ?? '', country: c[countryCol] ?? '' });
    }
  }
  return out;
}

// ---------- main ----------
const roster = await fetchRoster();

let table;
let source;
if (TSV_PATH) {
  table = readTsv(TSV_PATH);
  source = `Stat Check Elo TSV export (${path.basename(TSV_PATH)}), ${table.length} rows; read from disk with --tsv, not a fresh pull.`;
} else {
  const { buf, fileName } = await pullWorkbook();
  const { rows, modified } = parseWorkbook(buf);
  table = tableFromRows(rows);
  source =
    `Stat Check Elo table (stat-check.com/elo, page says last updated 16 October 2026), ${table.length} rows from Sheet1 of the embedded OneDrive workbook ${fileName} ` +
    `(workbook last modified ${modified ?? 'unknown'}), pulled by headless Playwright reading the embed's own share lookup and downloading the file.`;
}

// Build the full-table map. A normalized name that appears twice with different Elo is ambiguous: dropped and reported with its candidates.
const tablePlayers = {};
const candidates = new Map(); // normalized name -> every table row carrying it
for (const row of table) {
  const key = normalizeName(row.name);
  if (!key) continue;
  const list = candidates.get(key);
  if (list) list.push(row);
  else candidates.set(key, [row]);
}
const dupes = new Set();
for (const [key, list] of candidates) {
  if (list.some((r) => r.elo !== list[0].elo)) dupes.add(key);
  else tablePlayers[key] = list[0].elo;
}

const rosterKeys = new Set(roster.map(normalizeName));
const players = {};
const misses = [];
const pending = [];
for (const display of roster.slice().sort((a, b) => a.localeCompare(b))) {
  const key = normalizeName(display);
  if (dupes.has(key)) {
    const list = candidates
      .get(key)
      .map((r) => `${r.elo} (${r.country || 'no country'}, last event ${r.lastEvent || 'unknown'})`)
      .join('; ');
    misses.push({ name: display, reason: `ambiguous: the Stat Check table lists this exact name ${candidates.get(key).length} times with different Elo: ${list}` });
    continue;
  }
  const hit = lookupEloIn(display, tablePlayers);
  if (!hit.known) {
    const reason = !isFullName(key)
      ? 'BCP display name is not a full first and last name (initial, single word or non-alphabetic last name); not guessed' +
        (candidates.has(key) ? `, although the table carries the same string at ${candidates.get(key).map((r) => r.elo).join('/')}` : '')
      : 'no exact name in the Stat Check table, and no single same-last-name candidate whose first name is a 3+ letter prefix match (none or several)';
    misses.push({ name: display, reason });
    continue;
  }
  if (hit.matchedAs === key) players[key] = hit.elo;
  else pending.push({ display, key, hit });
}
// A fuzzy hit (same last name, first-name prefix) is dropped if that table name is also another roster player's own name, or two fuzzy hits share it.
const fuzzyCount = new Map();
for (const p of pending) fuzzyCount.set(p.hit.matchedAs, (fuzzyCount.get(p.hit.matchedAs) ?? 0) + 1);
for (const { display, key, hit } of pending) {
  if (rosterKeys.has(hit.matchedAs) || fuzzyCount.get(hit.matchedAs) > 1) {
    misses.push({
      name: display,
      reason: `first-name prefix + last-name candidate "${hit.matchedAs}" is claimed by another roster player; not guessed`,
    });
  } else {
    players[key] = hit.elo;
  }
}
misses.sort((a, b) => a.name.localeCompare(b.name));

const snapshot = {
  generatedAt: new Date().toISOString(),
  source,
  players: Object.fromEntries(Object.entries(players).sort(([a], [b]) => a.localeCompare(b))),
  misses,
};
fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n');

console.log(
  `${Object.keys(players).length}/${roster.length} roster players matched; ${misses.length} misses; table ${table.length} rows; wrote ${path.relative(repoRoot, outPath)}`,
);
for (const m of misses) console.log(`  miss: ${m.name} -> ${m.reason}`);
