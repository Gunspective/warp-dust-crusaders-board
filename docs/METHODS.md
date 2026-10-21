# Team-event coach board: how the forecasts are built

(Copy of the coach-board methods write-up, kept with the code it describes. Source paths in this repo: the maths is `src/lib/wdc/` and `src/components/wdc/model.ts`; the snapshot builders are `scripts/`.)

This is how the Warp Dust Crusaders coach board turns public data into a 0-20 forecast for every possible pairing at a Warhammer 40,000 team event. It covers the four data sources, how each one is collected, and the exact maths that combines them. Everything here can be rebuilt in any language; nothing depends on our website.

Written 2026-10-19 after TEO-8 (Hopkinsville, KY). Numbers in the examples are real TEO-8 data.

---

## 1. What the board computes

For each pairing of one of our players (us) against one of theirs (them), the board shows our expected game points out of 20:

```
logit = eloTerm(us, them)
      + wFaction * factionEdge(us.army, them.army)
      + wForm    * formEdge(us, them)
      + wHistory * historyEdge(us, them)

p        = 1 / (1 + e^(-logit))
forecast = clamp(round(20 * p), 0, 20)
shown    = clamp(forecast + coachNudge, 0, 20)
```

- `eloTerm` comes from Stat Check player Elo (section 3).
- `factionEdge` comes from Stat Check's army-versus-army matchup matrix (section 4).
- `formEdge` and `historyEdge` come from each player's BCP game history in the current edition (section 5).
- Default weights: `wFaction = 1`, `wForm = 0.5`, `wHistory = 1`. Each can be set from 0 (off) to 2 in steps of 0.25. With `wForm = wHistory = 0` and no faction data, the forecast is pure Elo.
- `coachNudge` is a whole-point adjustment the coach adds per table (from -20 to +20).

A team match is 8 games of 20 points, 160 total: 81 or more wins, exactly 80 draws. The board adds the eight forecasts to show the predicted match total and how many points per remaining game the team needs to win or draw.

---

## 2. Rosters, pairings and results: Best Coast Pairings (BCP)

BCP's public API answers without a login when you send the header `client-id: web-app`. It is unofficial and undocumented, so be polite: at most a few concurrent requests, retry 429 and 5xx with backoff, and cache responses.

Base URL: `https://newprod-api.bestcoastpairings.com/v1`

| What | Endpoint | Notes |
|---|---|---|
| Event | `/events/{eventId}` | `eventDate`, `numberOfRounds`, `gameSystemId` (40K is `WGMSzfKFYA`) |
| Team standings | `/events/{eventId}/teamPlayers?placings=true` | `active[]` with `name`, `placing`, `metrics[]` (Match Points, Game Wins, Battle Points...) |
| Team pairings for a round | `/events/{eventId}/pairings?eventId={eventId}&pairingType=TeamPairing&round={n}` | which team plays which |
| Player games for a round | `/events/{eventId}/pairings?eventId={eventId}&pairingType=Pairing&round={n}` | one row per game |
| A user's event entries | `/players?userId={userId}&limit=50&sortAscending=false` | newest first, paginate with `nextKey` |
| One entry's games | `/players/{eventPlayerId}/pairings` | every game that player played at that event |

A player-game row looks like:

```
{ table, round, isDone, teamPairingId,
  player1: { id, user: { id, firstName, lastName }, team, faction, subFaction, listId },
  player2: { ... },
  player1Game: { result, points }, player2Game: { result, points } }
```

- `faction` is the army; `subFaction` is the disposition (11th edition).
- `result`: 2 = win, 1 = draw, 0 = loss. Trust the result code over points: some events score raw victory points (81-64) and some tiebreak a 10-10 game as 2/0.
- List links: `https://www.bestcoastpairings.com/list/{listId}`.

Gotchas we hit, all real:

1. **Team labels on player rows are unreliable.** `player.team` is often the player's club name, not the event team (53 of 128 seats at TEO-8). Attribute each game to a team through `teamPairingId` and the TeamPairing rows instead.
2. **Team pairings post before player pairings.** At TEO-8, BCP created a round's team pairings at once, then each match's 8 player rows anywhere from 5 minutes to 7 hours later. During that gap a round exists with 0 player tables for your match. Do not treat it as played, and do not score it as 0-160.
3. **Byes.** A bye row has no opponent seat. At TEO-8 a bye scores a flat 20. A row with no opponent but a real score between 1 and 19 is a played game whose opponent BCP lost (it happened to one of our players at ATC Tennessee); count it. A 0-point no-opponent row is a drop or forfeit; skip it.
4. **Rows without a table number** occasionally appear; drop them.

---

## 3. Player Elo: Stat Check

Source: stat-check.com/elo publishes its player Elo table as an embedded OneDrive Excel workbook (Sheet1, columns include Name and Elo; about 46,000 rows in October 2026).

Collecting it: a direct download link on the share returns 403. What works is opening the embed in a headless browser (we used Playwright) and watching the page's own share lookup request (`.../_api/v2.0/shares/...`), whose JSON answer carries `@content.downloadUrl`, a pre-authorized link to the .xlsx. Download that and read Sheet1. Never log or store the tokens in that URL. Stat Check updates the table periodically; re-pull before each event.

Matching BCP names to Stat Check names (this matters more than anything else in the Elo step):

1. Normalize both sides: lower-case, strip accents, remove punctuation, collapse spaces.
2. Exact match wins.
3. Otherwise a fallback match: same last name, and one first name is a prefix of the other with at least 3 letters (Sam / Samuel yes; Vinny / Vinicius, CJ / Christian, Aaron / Ash no), and only when exactly one Stat Check row fits.
4. Drop a fallback hit if that Stat Check name belongs to another player on the event's rosters (at TEO-8, "Sam Young" fuzzily matched "Samuel Young", who was also playing).
5. Never guess handles like "A. Lee" or "dylan 40k". Unmatched players get 1400 and are shown greyed so the coach knows the number is a placeholder; the coach can override any player's Elo.

At TEO-8 this matched 103 of 136 players; every miss is listed by name with its reason.

The Elo term:

```
eloTerm(us, them) = ln(10) * (us.elo - them.elo) / 290
```

That is standard Elo expectancy with a scale of 290 instead of chess's 400. With 400, real 40K Elo gaps kept every forecast between 7 and 13; 290 spreads them so a 100-point edge reads about 14-6, 200 about 17-3, and 330 about 19-1.

---

## 4. Army-versus-army matchups: Stat Check Matchup Matrix

Source: Stat Check's public Tableau dashboard "Stat Check | The 40k Meta Data Dashboard - 11th Edition", tab "Matchup Matrix" (public.tableau.com, workbook `StatCheckThe40kMetaDataDashboard-11thEdition`). Default filters: current meta (it read "Armageddon 1.04"), mirrors excluded. For each player faction against each opponent faction it has win rate, average game score differential and total games. In October 2026: 692 pairings, 29 factions, 2,160 games.

Collecting it: Stat Check has switched data download off on this dashboard. We read the values the dashboard sends to every visitor's browser: load the Matchup Matrix view in a headless browser, capture the `bootstrapSession` response, and read the worksheet "Matchup Matrix Sheet" (fields Player Faction, Opponent Faction, AVG(Win Rate), SUM(Total Games)). Because the author chose not to offer downloads, we only ever show forecasts derived from these numbers, never the table itself. If your team wants the raw matrix, ask Stat Check.

Name mapping BCP to Stat Check: strip a trailing parenthetical ("Space Marines (Astartes)" to "Space Marines"), fold apostrophes and case, and alias "Genestealer Cult" to "Genestealer Cults". Anything Stat Check does not list (BCP's "Imperium") counts as even.

The faction edge, shrinking thin samples toward 50%:

```
K = 20                                  // pseudo-games of a 50% prior
wrShrunk = (wr * games + 0.5 * K) / (games + K)
wrShrunk = clamp(wrShrunk, 0.05, 0.95)
factionEdge = ln(wrShrunk / (1 - wrShrunk))     // 0 for a mirror or a missing row
```

Use the row for our army against theirs (the matrix is symmetric: A v B and B v A sum to 1). With K = 20 a one-game 100% row moves an even forecast by at most 1 point; the biggest swing any real row produces at even Elo is 3 points.

---

## 5. Player performance: the player database

This is the "player DB": every player's games in the current edition, built from BCP for everyone on the event's rosters.

Collecting it (about 3,000 requests for 136 players; under 2 minutes cold with 4 concurrent requests, seconds from cache):

1. Collect every roster player's BCP user id and display name from the event's player pairings (all posted rounds).
2. For each user, page `/players?userId=...` back over the window you care about.
3. For each entry, fetch `/events/{eventId}` (cache it) and keep only 40K events (`gameSystemId = WGMSzfKFYA`) inside the window.
4. For each kept entry, fetch `/players/{eventPlayerId}/pairings`, keep finished games with a result code, apply the bye rules in section 2, and record: date, result, my army, my disposition, opponent army.

Edition window: we count only 11th edition games, starting at ATC Tennessee (Chattanooga, events dated 2026-06-26). Dispositions (BCP `subFaction`) only exist in 11th edition, which is a useful sanity check: no 40K entry before late June 2026 carries one.

Stored per player (keyed by the normalized display name, same normalization as Elo):

```
ed11: { g, w, d, l }                                   // all 11th edition games
vs:   { "<opponent army>": { g, w, d, l } }            // 11th games by opponent army
as:   { "<my army>|<my disposition>": {                // 11th games by what the player brought
          g, w, d, l,
          vs: { "<opponent army>": { g, w, d, l } } } }
```

Armies use the Stat Check names from section 4 so the two sources line up. A draw counts as half a win everywhere: `share = (w + d/2) / g`.

Always display records with the letters, like `8W 0D 1L`. A bare `57-2-10` was read as wins-losses-draws by one of our own players.

### 5a. Form edge (how good each player is in this edition)

```
K = 20
shrunk(r) = (r.w + r.d/2 + 0.5*K) / (r.g + K)      // toward 50%; no games = 0.5
formEdge  = logit(shrunk(us.ed11)) - logit(shrunk(them.ed11))
```

Default weight 0.5, because Elo already reflects most of a player's overall strength.

### 5b. History edge (how each player does into this specific army)

For each side, take the most specific record into the other side's army: prefer `as["<my army>|<my disposition>"].vs[their army]`, else `vs[their army]`. Then shrink that record toward the player's OWN edition share, not toward 50%:

```
K  = 10
p0 = shrunk(player.ed11)  with K = 10, toward 0.5      // the player's norm
term(player, army) = logit((r.w + r.d/2 + K*p0) / (r.g + K)) - logit(p0)
historyEdge = term(us, them.army) - term(them, us.army)
```

The shrink target is the lesson we paid for. Our first version shrank the army record toward 50%, which made a strong player's short unbeaten run into an army read as underperformance (a 27-1-2 player who was 1-0 into Death Guard lost 4 points of forecast). Shrinking toward the player's own share can never do that: an unbeaten record is always 0 or positive, a winless one always 0 or negative. A draw-only record reads slightly below the norm of a player who wins more than half their games, which is correct for a half-win.

Missing player or missing army row: the term is 0.

---

## 6. Worked example (TEO-8 round 5)

Hogan Franklin (Emperor's Children, Priority Assets) against Justin Mooneyham (Space Marines, Take and Hold):

| Step | Value |
|---|---|
| Elo + armies only | 9 of 20 |
| Hogan in 11th | 20W 2D 2L |
| Mooneyham in 11th | 22W 2D 17L |
| Hogan into Space Marines | 1W 0D 0L |
| Mooneyham into Emperor's Children | 0W 0D 2L |
| Forecast at default weights | 14 of 20 |

That is the largest single move on the round 5 grid (5 points); every move of 3 or more pointed the way the records point.

---

## 7. Pairing the next round

Swiss pairing puts you against a team on the same score where possible. The board's opponent shortlist is every team within one match result (2 match points, since a win is 2 and a draw 1) of yours, minus teams already played, sorted by BCP placing, with a Show all for the rest. TEO-8 tiebreaker order was match points, then game wins (a draw is half a game win).

---

## 8. Checking your build

What we test, and what caught real bugs:

- Rebuild the formula independently and compare every cell of a real 8x8 grid at several weight settings: zero mismatches.
- With all extra weights at 0 and no faction data, forecasts must equal pure Elo exactly.
- Recount 3 players' records straight from BCP and compare with the player DB, game by game. This caught the missing ATC game above.
- Sign test: no unbeaten record into an army may lower a forecast, no winless one may raise it.
- Show every number the forecast uses as visible text when a cell is tapped. Tooltips do not exist on phones or tablets, and the coach needs to see why a cell says what it says.
- Refresh the player DB between rounds so the event's own games count.
