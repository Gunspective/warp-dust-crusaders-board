# Coach board runbook

For the owner and the coach. The design and the rules are in `CONTRACT.md`; setup and deploy are
in `../README.md`; this file is what to do on event day and between events. No PIN, key or token
is written in this file, and none should be.

## 1. What it is

A full-screen tablet page for the Warp Dust Crusaders. It reads the live team list and pairings
from Best Coast Pairings (BCP), puts each player's Elo, faction and disposition next to the list,
and predicts the team match (8 games, 160 points, 81 wins, 80 draws). Anyone with the link can
look. Only someone with the coach PIN can save a score, a nudge, a pairing lock or the weights.
The page is not linked from anywhere and is hidden from search.

## 2. Event day on the tablet (coach)

1. Open the board's address in the tablet browser. Keep it in landscape. The screen stays awake
   while the page is open on tablets that allow it.
2. Two views at the top: Board (our 8 tables for the round, round buttons R1 to R5 that light up
   as BCP posts each round) and Pairing (pick the opponent and build the tables).
3. Board: each card shows both players, Elo, faction, disposition, a List link to the BCP army
   list, and the forecast. The strip shows predicted total, locked points, projected total and
   what we still need to win or draw.
4. Tap a card to open the score pad. Tap our points, 0 to 20 (theirs is 20 minus ours). One tap
   saves and closes. "Clear score" on the pad removes a coach-entered score.
5. The first save on a tablet asks for the coach PIN. After it is accepted the tablet remembers
   it. Clearing the browser data or using a private tab asks again.
6. A score BCP has posted always wins over a score typed here. Typed scores show until BCP has
   the result.
7. Pairing view: choose the opponent from the short list of teams within one match result (2
   match points) (use "show all" for the rest), tap grid cells to lock our player against theirs,
   then "Set tables for round N". When BCP posts the real pairings they replace the locks. Scores
   and nudges typed on those tables belong to our player, not to the table number, so they move
   with each player to whatever table BCP gives them.
8. The page refreshes itself every 30 seconds while it is on screen, and again when you come back
   to the tab. It does not refresh over a save or a PIN box that is open.
9. Weights (header button): minus and plus set how much the forecast leans on faction matchups,
   11th edition form and 11th edition results against this army (0x off, 1.0x full, 2.0x double);
   each tap saves with the coach PIN like a score, and Reset to defaults puts back 1.0x, 0.5x, 1.0x.

### Messages you may see

- "BCP unreachable since hh:mm. Showing the last good board." BCP did not answer. The time is
  the last saved good read (within 15 minutes of the real last read), in the tablet's clock.
  Saves still work. The board catches up on its own when BCP answers again.
- "Wrong PIN": retype it. "Coach PIN not set": the owner has not set one (README.md, "Coach PIN").
- "Too many tries": 10 wrong PINs inside 10 minutes lock saving for everyone, including the right
  PIN, until 10 minutes after the first wrong one. Wait, then try once. The owner can lift it at
  once by deleting the counter (README.md, "PIN throttle"). Reading the board is never blocked.
- "Save failed: storage error": the board's storage refused the write three times; tap again.
- "Could not reach the server": no signal; the score was not saved, tap it again.

## 3. Between events (owner)

- New event: set `wdc.event` (and `wdc.team` if the team name changed) in KV, then refresh the
  three snapshots and deploy (README.md). The coach's scores and locks are kept per event
  (`wdc.state.{eventId}`), so a new event starts clean and the old one is untouched.
- Between rounds: rerun `scripts/statcheck-elo.mjs` after round 1 pairs (fresh rosters appear as
  BCP publishes rounds) and deploy, if new names matter.

## 4. Known limits

- Names BCP shows as handles ("Butters s", "A. Lee", "dylan 40k") are never guessed. They stay
  1400 and grey, as do names missing from Stat Check and names the table lists twice with
  different Elo.
- Coach Elo fixes (`eloOverrides`, a number 100 to 3000 per player name) beat the snapshot, but
  the tablet has no screen to enter them. Today the owner adds them to the `eloOverrides` object
  inside the `wdc.state.{eventId}` KV value (read it with `wrangler kv key get`, edit, put it
  back). Keep the rest of that JSON as it is.
- The next round's tables from locks appear only when exactly 8 pairs are locked, the opponent
  has not been played, and BCP has not posted that round yet.
- If BCP pairs us against a different team than the one locked, the scores and nudges typed for
  that round are hidden (kept, not deleted). The first new entry against the real opponent starts
  that round fresh; the hidden ones are then gone.
- The PIN lockout is global and best effort (CONTRACT.md C3): anyone who guesses wrong 10 times
  in a row locks out the coach for up to 10 minutes, and a fast parallel burst is undercounted.
- KV is eventually consistent between Cloudflare locations: a phone served by a far-away
  location can show a save up to about a minute late. Devices at the same venue see it at once.
- A score of 0 from BCP counts as posted only when BCP marks the game done.
- If BCP changes its public API the board falls back to the last good copy and says so; it never
  shows a blank page.
