# Player history and forecast weights (owner 2026-10-18)

Owner: "I would also like to input some weights on how the players past performance has been over all the events from the last year. Each player should have data from 11th, that shows how they perform on faction/disposition against an army. We should have those weights as well."

## Snapshot: src/lib/wdc/player-history-snapshot.json (written by scripts/bcp-history.mjs)

```
{
  "generatedAt": "ISO",
  "eventId": "JkPs5aELBHPh",
  "windowStart": "YYYY-MM-DD",          // 365 days before generatedAt
  "editionStart": "YYYY-MM-DD",         // 2026-06-26: 11th edition started at ATC Tennessee (owner 2026-10-18)
  "players": {
    "<normalizeName(display name)>": {   // normalizeName from src/lib/wdc/elo.ts
      "name": "Display Name",
      "year":  { "g": 0, "w": 0, "d": 0, "l": 0 },          // all 40K games in the window
      "ed11":  { "g": 0, "w": 0, "d": 0, "l": 0 },          // games on/after editionStart
      "vs":    { "<oppFaction>": { "g": 0, "w": 0, "d": 0, "l": 0 } },   // ed11 games by opponent army
      "as":    { "<myFaction>|<myDisposition>": {            // ed11 games by what this player brought
                   "g": 0, "w": 0, "d": 0, "l": 0,
                   "vs": { "<oppFaction>": { "g": 0, "w": 0, "d": 0, "l": 0 } } } }
    }
  }
}
```
- Faction keys are Stat Check names (use `resolveFaction` / `factionKey` from src/lib/wdc/matchups.ts so "Space Marines (Astartes)" -> the Stat Check "Space Marines"); disposition is BCP's `subFaction` name as given ("" when missing).
- Only Warhammer 40,000 events (event gameSystemId WGMSzfKFYA); only finished games with a result; byes skipped; the current event (TEO-8) included.

## Forecast (all log-odds, added to the Elo term)
`logit = Elo term + wFaction * factionEdge + wForm * formEdge + wHistory * historyEdge`, then 20p, round, clamp 0..20, then the nudge.
- factionEdge: as today (Stat Check matchups).
- formEdge (11th edition only, owner 2026-10-18 "Only do it for 11th"): logit(shrunk ed11 win share) for us minus the same for them, where win share = (w + d/2)/g shrunk toward 0.5 by K = 20 games. The `year` record stays in the snapshot but feeds nothing.
- historyEdge (11th edition vs this army): for our player, prefer `as["<myFaction>|<myDispo>"].vs[themFaction]`, else `vs[themFaction]`. Shrink that army record toward the player's OWN 11th edition share, not toward 50%: p0 = shrunk(ed11, K=10) toward 0.5; term = logit((w + d/2 + 10*p0)/(g + 10)) - logit(p0). Mirror for their player against our army and subtract. (QA 2026-10-18: shrinking the army record toward 50% made a strong player's short unbeaten run into an army read as underperformance in 43 of 86 round 5 terms; this form can never do that, and a test pins it.)
- Weights live in the coach document: `weights?: { faction: number, form: number, history: number }`, each 0..2 in steps of 0.25; defaults faction 1, form 0.5, history 1. The form weight is labelled "11th edition form" on the board. Missing = defaults. The document is stored in KV key `wdc.state.{eventId}` (CONTRACT.md C3).

- Records are shown as "57W 2D 10L" (wins, draws, losses spelled out): a bare 57-2-10 was misread by the owner.
- No-opponent rows: a row with no opponent recorded counts as a game when the player's points are 1..19 (a played score whose opponent BCP lost, e.g. ATC Tennessee round 1); a flat 20 or 0 stays a bye or forfeit.
- Draws count as half a win everywhere. So a draw-only record into an army reads slightly below a player's norm when their own 11th share is above 50% (final QA 2026-10-18: Nicholas Fromme 0W 1D 0L into T'au and into Sororitas, 1 point each at default weights); this is intended and tested.
