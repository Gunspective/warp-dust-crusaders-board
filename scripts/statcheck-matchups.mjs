// Builds src/lib/wdc/matchup-snapshot.json for the coach board (contract C4: the faction edge on the forecast).
// Run from the repo root:  node scripts/statcheck-matchups.mjs   (no TypeScript imports, so any Node 18+ or Bun runs it)
//
// Source: Stat Check's public Tableau dashboard "StatCheckThe40kMetaDataDashboard-11thEdition", tab Matchup Matrix.
// The author disabled data download, so this reads what the dashboard sends every visitor: a headless Playwright
// page opens the view and keeps the vizql bootstrapSession response, whose second chunk carries the data
// dictionary and the "Matchup Matrix Sheet" worksheet (Player Faction, Opponent Faction, AVG(Win Rate),
// SUM(Total Games), plus score differential columns this board does not use). No login, token or cookie is
// involved, logged or saved.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const outPath = path.join(repoRoot, 'src', 'lib', 'wdc', 'matchup-snapshot.json');
const VIEW_URL = 'https://public.tableau.com/views/StatCheckThe40kMetaDataDashboard-11thEdition/MatchupMatrix';
const SHEET = 'Matchup Matrix Sheet';

const args = process.argv.slice(2);
const argVal = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
// --response <file> parses a saved bootstrapSession body (first line the URL, as a capture writes it) instead of loading the page.
const RESPONSE_PATH = argVal('--response', null);

// ---------- pull ----------
async function loadPlaywright() {
  const candidates = [];
  try {
    candidates.push(execSync('npm root -g', { encoding: 'utf8' }).trim());
  } catch {
    // fall through
  }
  candidates.push(path.join(process.env.APPDATA ?? '', 'npm', 'node_modules'));
  candidates.push(path.join(repoRoot, 'node_modules'));
  for (const root of candidates) {
    try {
      return createRequire(path.join(root, 'x.js'))('playwright');
    } catch {
      // try next
    }
  }
  return createRequire(import.meta.url)('playwright');
}

async function pullBootstrap() {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1800, height: 1200 } })).newPage();
    let body = null;
    page.on('response', async (r) => {
      if (body || !/\/vizql\/w\/.*\/bootstrapSession\//.test(r.url())) return;
      try {
        body = await r.text();
      } catch {
        // ignore
      }
    });
    await page.goto(`${VIEW_URL}?:showVizHome=no&:tabs=yes`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    for (let i = 0; i < 120 && !body; i++) await page.waitForTimeout(500);
    if (!body) throw new Error('the dashboard never answered its bootstrapSession request');
    return body;
  } finally {
    await browser.close();
  }
}

// ---------- parse ----------
// The body is a run of `<length>;<json>` chunks; the second one holds the data.
function chunks(body) {
  const parts = [];
  let i = 0;
  while (i < body.length) {
    const sc = body.indexOf(';', i);
    if (sc < 0) break;
    const len = Number(body.slice(i, sc));
    if (!Number.isFinite(len)) break;
    parts.push(body.substr(sc + 1, len));
    i = sc + 1 + len;
  }
  return parts;
}

function extractRows(body) {
  const parts = chunks(body);
  if (parts.length < 2) throw new Error(`bootstrapSession answered ${parts.length} chunk(s), expected 2`);
  const second = JSON.parse(parts[1]);
  const map = second?.secondaryInfo?.presModelMap;
  const segs = map?.dataDictionary?.presModelHolder?.genDataDictionaryPresModel?.dataSegments;
  const ws = map?.vizData?.presModelHolder?.genPresModelMapPresModel?.presModelMap?.[SHEET];
  if (!segs || !ws) throw new Error(`no data dictionary or no "${SHEET}" worksheet in the response`);
  const dict = {};
  for (const k of Object.keys(segs)) for (const c of segs[k].dataColumns) (dict[c.dataType] ||= []).push(...c.dataValues);
  const pcd = ws.presModelHolder.genVizDataPresModel.paneColumnsData;
  const cols = {};
  for (const c of pcd.vizDataColumns) {
    if (!c.fieldCaption) continue;
    const pc = pcd.paneColumnsList[c.paneIndices[0]].vizPaneColumns[c.columnIndices[0]];
    const idx = pc.aliasIndices && pc.aliasIndices.length ? pc.aliasIndices : pc.valueIndices;
    // A negative index points into the string table (aliases), a non-negative one into the column's own type.
    cols[c.fieldCaption] = idx.map((j) => (j >= 0 ? dict[c.dataType][j] : dict.cstring[-j - 1]));
  }
  for (const f of ['Player Faction', 'Opponent Faction', 'AVG(Win Rate)', 'SUM(Total Games)']) {
    if (!cols[f]) throw new Error(`worksheet has no "${f}" column (found: ${Object.keys(cols).join(', ')})`);
  }
  const rows = [];
  for (let r = 0; r < cols['Player Faction'].length; r++) {
    const wr = Number(cols['AVG(Win Rate)'][r]);
    const games = Number(cols['SUM(Total Games)'][r]);
    const p = cols['Player Faction'][r];
    const o = cols['Opponent Faction'][r];
    if (typeof p === 'string' && typeof o === 'string' && Number.isFinite(wr) && Number.isFinite(games)) {
      rows.push({ p, o, wr, games });
    }
  }
  return rows;
}

// The Meta filter's selection summary ("Armageddon 1.04") and the dashboard's own "Last Updated: mm.dd.yyyy" text.
function readMeta(body) {
  const at = body.indexOf('"columnFullNames":["[Meta]"]');
  const m = at >= 0 ? /"selectionSummary":\s*"([^"]+)"/.exec(body.slice(at, at + 4000)) : null;
  return m ? m[1] : null;
}
function readUpdated(body) {
  const m = /Last Updated:\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(body);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

// ---------- main ----------
const raw = RESPONSE_PATH ? fs.readFileSync(RESPONSE_PATH, 'utf8') : await pullBootstrap();
const body = RESPONSE_PATH ? raw.slice(raw.indexOf('\n') + 1) : raw;
const list = extractRows(body);
if (list.length === 0) throw new Error('the Matchup Matrix worksheet carried no rows');

const round4 = (n) => Math.round(n * 10000) / 10000;
const rows = {};
for (const { p, o, wr, games } of list.slice().sort((a, b) => a.p.localeCompare(b.p) || a.o.localeCompare(b.o))) {
  (rows[p] ||= {})[o] = { wr: round4(wr), games: round4(games) };
}

const snapshot = {
  generatedAt: new Date().toISOString(),
  source: VIEW_URL,
  meta: readMeta(body),
  updated: readUpdated(body),
  rows,
};
fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n');

const factions = new Set(list.flatMap((r) => [r.p, r.o]));
const games = list.reduce((s, r) => s + r.games, 0);
console.log(
  `${list.length} matchup rows, ${factions.size} factions, ${games} games (each game counted from both sides), meta ${snapshot.meta ?? 'unknown'}, dashboard updated ${snapshot.updated ?? 'unknown'}; wrote ${path.relative(repoRoot, outPath)}`,
);
