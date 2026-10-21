# Warp Dust Crusaders coach board

A full-screen tablet board for the Warp Dust Crusaders at a Warhammer 40,000 team event. It reads
the live rosters, pairings and posted scores from Best Coast Pairings (BCP), puts each player's
Elo, faction, disposition and army-list link side by side, forecasts every game 0-20 (Elo, Stat
Check faction matchups and 11th edition player history), and shows what the team needs to win
or draw the match. The coach enters scores, nudges forecasts and builds the next round's
pairings from the tablet, behind a PIN.

It is private by obscurity: anyone with the link can read it, nothing links to it, and it is kept
out of search (robots meta tag plus `X-Robots-Tag: noindex, nofollow` on every response).

- `docs/CONTRACT.md`: what the board does and how (the rules, as built).
- `docs/METHODS.md`: the forecast maths and data sources in full.
- `docs/HISTORY.md`: the player-history snapshot and the forecast weights.
- `docs/RUNBOOK.md`: event day on the tablet, between events, known limits.

## How it is built

One Cloudflare Worker (`wrangler.jsonc`) does everything:

- `GET /api/board`: the merged board. The Worker calls BCP (cached 60 s), merges the coach's
  saved document and the Elo snapshot, and answers JSON. A BCP outage answers the last good
  snapshot with `stale: true`; it never fails the page.
- `POST /api/save`: the PIN-gated save of the whole coach document, answering a JSON envelope
  `{ok: true, state}` or `{ok: false, reason, message}` (64 KB cap, full validation).
- Everything else: the built single-page app from `./dist` (Workers static assets, with the
  fallback to `index.html`).
- Security headers on every response: a Content-Security-Policy for this page (this origin,
  inline styles, Bunny Fonts), `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `X-Robots-Tag: noindex, nofollow`.

Storage is one Workers KV namespace, bound as `WDC_KV`. Keys:

| Key | What |
| --- | --- |
| `wdc.event` | BCP event id (the code in the BCP event URL). Default `JkPs5aELBHPh` (TEO-8). |
| `wdc.team` | Our team name as BCP spells it. Default `Warp Dust Crusaders`. |
| `wdc.state.{eventId}` | The coach document: scores, nudges, pairing locks, Elo fixes, weights. |
| `wdc.snapshot.{eventId}` | Last good BCP read, served when BCP is down. |
| `wdc.pin.sha256` | Optional hex SHA-256 of the coach PIN (wins over the secret). |
| `wdc.pin.fails2` | Wrong-PIN counter `{count, windowStart}`. |

Code layout:

```
index.html                 page shell (title, robots meta, fonts)
src/main.tsx, src/app.tsx  entry; loads the first board, then renders the board
src/components/wdc/        the board UI (board, pairing grid, score pad, weights sheet)
src/lib/api/wdc.functions.ts  browser client: getWdcBoard(), saveWdcCoachState({ data })
src/lib/wdc/               BCP client, Elo, matchups, history maths, state layer (KV), snapshots
src/worker/                the Worker: index.ts (entry), handler.ts (routes), headers.ts
scripts/                   snapshot builders (Elo, faction matchups, player history)
```

## Local development

Needs Node 22.18 or newer (the snapshot scripts import TypeScript helpers directly).

```sh
npm install
npm test               # vitest: lib maths, BCP client, state with a fake KV, page, Worker
npm run typecheck      # tsc --noEmit
npm run build          # vite build -> ./dist
npm run preview        # build, then wrangler dev --local on http://localhost:8787
```

`npm run preview` runs the real Worker in workerd with a local, empty KV (kept under
`.wrangler/`, git-ignored); it calls BCP live if the machine is online. To try saves locally,
give it a throwaway PIN hash (not the real one), for example:

```sh
npx wrangler dev --local --var WDC_PIN_SHA256:$(printf '%s' 'test-pin' | sha256sum | cut -c1-64)
```

`npm run dev` serves the UI alone with hot reload and proxies `/api` to a `wrangler dev` running
on port 8787.

## Deploy

One-time setup on the Cloudflare account (wrangler logged in to that account):

1. The KV namespace already exists for this deployment and its id is in `wrangler.jsonc`.
   Only for a fresh Cloudflare account: create one and put its id in `wrangler.jsonc`.

   ```sh
   npx wrangler kv namespace create WDC_KV
   ```

2. Set the coach PIN (next section).
3. Deploy (runs typecheck, tests and the build first):

   ```sh
   npm run deploy
   ```

4. Custom domain: once the domain's zone is on the same account, add to `wrangler.jsonc`

   ```jsonc
   "routes": [{ "pattern": "warpdustcrusader.com", "custom_domain": true }]
   ```

   and deploy again. Set `"workers_dev": false` too if the `*.workers.dev` address should stop
   answering.

Every later change ships with `npm run deploy`.

## Coach PIN

Only the SHA-256 of the PIN is ever stored. The tablet trims what the coach types, and a PIN
whose first letter a phone keyboard capitalised also matches, so use a lower-case or numeric PIN.

Set or change it with a Worker secret, the hash piped straight in so the PIN is never typed into
a file or a command line (bash; the `read -s` prompt does not echo):

```sh
read -rs PIN && printf '%s' "$PIN" | sha256sum | cut -c1-64 | npx wrangler secret put WDC_PIN_SHA256; unset PIN
```

PowerShell:

```powershell
$s = Read-Host -AsSecureString "Coach PIN"
$p = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
$h = -join ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($p)) | ForEach-Object { $_.ToString("x2") })
$h | npx wrangler secret put WDC_PIN_SHA256; Remove-Variable s, p, h
```

A hash stored in KV key `wdc.pin.sha256` wins over the secret, if one is ever written there.
Tablets holding the old PIN ask for the new one on their next save.

Switch the PIN off (saves need no PIN and are never throttled; the board stops asking):

```sh
printf '1' | npx wrangler secret put WDC_PIN_OFF
```

Switch it back on with `npx wrangler secret delete WDC_PIN_OFF` (any value other than `1` also
leaves the PIN on). Secrets take effect without a redeploy.

### PIN throttle

10 wrong PINs inside 10 minutes lock saving for everyone until 10 minutes after the first wrong
one. Workers KV has no atomic increment, so this is best effort: guesses that race in parallel,
or arrive through different Cloudflare locations, can be undercounted (CONTRACT.md C3). For a
strict limit, add a Cloudflare rate-limiting rule on `POST /api/save` (for example 20 requests a
minute per IP) once the custom domain is live.

Lift a lockout early:

```sh
npx wrangler kv key delete --binding WDC_KV --remote wdc.pin.fails2
```

## Point the board at an event

The event and team come from KV (wrangler 4 needs `--remote` to touch the deployed namespace):

```sh
npx wrangler kv key put --binding WDC_KV --remote wdc.event <BCP event id>
npx wrangler kv key put --binding WDC_KV --remote wdc.team "Warp Dust Crusaders"
```

With no `wdc.event` the board shows `JkPs5aELBHPh` (TEO-8 "All in.", Hopkinsville KY, October
2026); with no `wdc.team`, `Warp Dust Crusaders`. The coach document is kept per event, so a new
event starts clean. Refresh the snapshots (next section) for the new event and deploy, or every
player shows a grey 1400.

## Refresh the snapshots

The repo ships all three snapshots EMPTY (every player shows a grey 1400 and the faction and
history terms are zero) because the Elo and matchup numbers belong to Stat Check, who have turned
downloads off on their dashboard: pull your own copy for your own use rather than passing ours
around. Generate them before the first deploy, and the repo-data tests in `src/lib/wdc/` start
running once the files have content.

The three snapshots are JSON files in `src/lib/wdc/`, bundled at build time, so a refresh is:
run the script, check its summary line, commit the JSON, `npm run deploy`. Run them from the repo
root. They need internet; the two Stat Check scripts also need Playwright with Chromium
(`npm i -g playwright && npx playwright install chromium`, or any install the scripts can find).
No script logs or saves a token or cookie.

| Script | Writes | When |
| --- | --- | --- |
| `node scripts/statcheck-elo.mjs --event <id>` | `elo-snapshot.json` | before the event, and after round 1 pairs (rosters come from BCP's published rounds); prints "N/M roster players matched" and names every miss |
| `node scripts/statcheck-matchups.mjs` | `matchup-snapshot.json` | before the event (Stat Check's Matchup Matrix dashboard) |
| `node scripts/bcp-history.mjs --event <id>` | `player-history-snapshot.json` | before the event, and between rounds if you want the current event's results in form and history; caches raw BCP replies in `scripts/.cache/` (git-ignored), `--fresh` ignores the cache |

`statcheck-elo.mjs --tsv <file>` reads a Stat Check TSV export instead of driving the browser.
The npm scripts `snapshot:elo`, `snapshot:matchups` and `snapshot:history` run the same three.
