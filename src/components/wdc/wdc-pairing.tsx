import { useEffect, useMemo, useState } from "react";
import {
  WDC_GAME_MAX,
  WDC_GAMES,
  type WdcBoardState,
  type WdcCoachState,
  type WdcPlayer,
  type WdcTeam,
} from "../../lib/wdc/types";
import {
  averageElo,
  FACTION_MARK_POINTS,
  forecastContext,
  HISTORY_MARK_POINTS,
  listHref,
  matchupLabel,
  pairForecast,
  pairHistoryLabel,
  type PairForecast,
} from "./model";

// Pairing view (C6): pick the opponent from the plausible Swiss pool, then an 8x8 grid of forecasts
// (our eight as rows, theirs as columns). Tapping a cell locks that pairing, table number = lock
// order; tapping it again unlocks. Elo plus the weighted Stat Check faction matchup edge and BCP
// player history edges (C4, docs/HISTORY.md); a cell the faction edge moved by 2 or more points
// carries a small F, one the player history moved by 2 or more a small H, and the label reads out
// the history numbers behind it. The coach nudge lives on a table once it exists.
//
// Touch screens never show title text, so the detail line above the grid spells out the last tapped
// cell (locked or unlocked by that tap): its forecast, the faction matchup and the history numbers
// (t-740). On tablets it is one line in the footnote's old height, with the full text in a small
// sheet a tap away; on a phone it wraps and sticks to the top while the grid scrolls.

type Pairing = WdcCoachState["pairing"];

const MID = "·";
const cls = (v: number) => (v >= 12 ? "good" : v <= 8 ? "bad" : "even");

function PlayerHead({ p, locked }: { p: WdcPlayer; locked: boolean }) {
  const href = listHref(p);
  return (
    <div className={`ph${locked ? " locked" : ""}`}>
      <span className="n">{p.name}</span>
      <span className="m" title={p.faction}>
        {/* "Space Marines (Astartes)" reads as "Space Marines": the suffix wraps the header and costs a row on tablets */}
        <b className={`num${p.eloKnown ? "" : " unk"}`}>{p.elo}</b> {MID}{" "}
        {p.faction.replace(/\s*\([^)]*\)\s*$/, "")}
      </span>
      <span className="m">{p.dispo}</span>
      {href && (
        <a href={href} target="_blank" rel="noopener noreferrer">
          List {"↗"}
        </a>
      )}
    </div>
  );
}

const LEGEND =
  "Green favors us, red against (H: history moved it 2+, F: faction moved it 2+). Tap to lock, tap again to unlock. Outlined: best remaining matchup.";

const optionLabel = (t: WdcTeam, played: boolean) =>
  `${t.placing ?? "-"}. ${t.name} (${t.matchPoints} MP)${played ? " - played" : ""}`;

export function PairingView({
  state,
  player,
  pairing,
  pairRound,
  shortlist,
  everyone,
  showAll,
  onToggleShowAll,
  onOpponent,
  onToggleLock,
  onClear,
  onSetTables,
}: {
  state: WdcBoardState;
  player: (name: string) => WdcPlayer;
  pairing: Pairing;
  /** The round the tables will be set for, or null once BCP has posted every round. */
  pairRound: number | null;
  shortlist: WdcTeam[];
  everyone: WdcTeam[];
  showAll: boolean;
  onToggleShowAll: () => void;
  onOpponent: (name: string) => void;
  onToggleLock: (us: string, them: string) => void;
  onClear: () => void;
  onSetTables: () => void;
}) {
  const ours = useMemo(() => (state.teams[state.our]?.players ?? []).map((p) => p.name), [state]);
  const theirs = useMemo(
    () =>
      pairing.opp && state.teams[pairing.opp]
        ? state.teams[pairing.opp].players.map((p) => p.name)
        : [],
    [state, pairing.opp],
  );
  const played = useMemo(() => new Set(state.played), [state.played]);

  const pool = showAll ? everyone : shortlist;
  const options =
    pairing.opp && !pool.some((t) => t.name === pairing.opp) && state.teams[pairing.opp]
      ? [state.teams[pairing.opp], ...pool]
      : pool;

  const lockedUs = new Set(pairing.locks.map((l) => l.us));
  const lockedThem = new Set(pairing.locks.map((l) => l.them));
  const lockOf = (u: string, t: string) =>
    pairing.locks.findIndex((l) => l.us === u && l.them === t);
  const ctx = useMemo(() => forecastContext(state), [state]);
  const pair = (u: string, t: string): PairForecast => pairForecast(player(u), player(t), 0, ctx);
  const forecast = (u: string, t: string) => pair(u, t).points;
  const total = pairing.locks.reduce((a, l) => a + forecast(l.us, l.them), 0);

  // The last tapped cell, for the detail line; a pick from another opponent's grid shows nothing.
  const [picked, setPicked] = useState<{ opp: string; us: string; them: string } | null>(null);
  const [open, setOpen] = useState(false);
  const shown =
    picked && picked.opp === pairing.opp && ours.includes(picked.us) && theirs.includes(picked.them)
      ? picked
      : null;
  const detail = shown ? cellDetail(shown.us, shown.them) : "";
  const expanded = open && !!detail;
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded]);

  // "Us Player 1 vs NearA Player 1: forecast 14-6 (Elo alone 12-8). Faction matchup: ... . <history>",
  // or "...: forecast 14-6, Elo only" when nothing but Elo is behind the cell.
  function cellDetail(u: string, t: string): string {
    const f = pair(u, t);
    const v = f.points;
    const parts = [
      f.matchup ? matchupLabel(f.matchup) : "",
      pairHistoryLabel(player(u), player(t)),
    ].filter(Boolean);
    const elo =
      v !== f.eloOnly
        ? ` (Elo alone ${f.eloOnly}-${WDC_GAME_MAX - f.eloOnly})`
        : parts.length
          ? ""
          : ", Elo only";
    return [`${u} vs ${t}: forecast ${v}-${WDC_GAME_MAX - v}${elo}`, ...parts].join(". ");
  }

  // Best remaining cell per row (our player) and per column (their player), among unlocked pairs.
  const bestRow: Record<string, { them: string; v: number }> = {};
  const bestCol: Record<string, { us: string; v: number }> = {};
  for (const u of ours) {
    if (lockedUs.has(u)) continue;
    for (const t of theirs) {
      if (lockedThem.has(t)) continue;
      const v = forecast(u, t);
      if (!bestRow[u] || v > bestRow[u].v) bestRow[u] = { them: t, v };
      if (!bestCol[t] || v > bestCol[t].v) bestCol[t] = { us: u, v };
    }
  }

  // Eight games a round: a ninth rostered player (a substitute) still gets a row but sits out, so the
  // round is ready at eight locks, the most the server stores.
  const full = pairing.locks.length >= WDC_GAMES;
  const ready = pairRound != null && ours.length > 0 && pairing.locks.length === WDC_GAMES;

  return (
    <section className="pair" aria-label="Pairing">
      <div className="bar">
        <label htmlFor="wdc-opp">Opponent</label>
        <select
          id="wdc-opp"
          className="text-base"
          value={pairing.opp}
          onChange={(e) => onOpponent(e.target.value)}
        >
          <option value="">Choose the team</option>
          {options.map((t) => (
            <option key={t.name} value={t.name}>
              {optionLabel(t, played.has(t.name))}
            </option>
          ))}
        </select>
        <button type="button" className="showall" aria-pressed={showAll} onClick={onToggleShowAll}>
          {showAll ? "Show likely only" : "Show all"}
        </button>
        {pairing.opp && (
          <>
            <span className="sum">
              <span>
                Their avg Elo <b className="num">{averageElo(theirs, player)}</b>
              </span>
              <span>
                ours <b className="num">{averageElo(ours, player)}</b>
              </span>
              <span>
                {pairing.locks.length} of {WDC_GAMES} locked, forecast{" "}
                <b className="num">{total}</b>
              </span>
            </span>
            {pairing.locks.length > 0 && (
              <button type="button" className="reset" onClick={onClear}>
                Clear
              </button>
            )}
            {pairRound != null && (
              <button type="button" className="go" disabled={!ready} onClick={onSetTables}>
                Set tables for round {pairRound}
              </button>
            )}
          </>
        )}
      </div>
      {pairRound == null && (
        <p className="readonly">
          BCP has posted every round, so the tables come straight from BCP.
        </p>
      )}
      {!pairing.opp ? (
        <div className="empty">
          Pick the opponent to see their eight with faction, disposition, Elo and lists, and the
          forecast for every possible pairing. The list shows teams within one match result (2 match
          points) of ours that we have not played; Show all adds the rest.
        </div>
      ) : (
        <>
          <div className={`pdetail${detail ? " on" : ""}`}>
            {detail ? (
              <button
                type="button"
                className="pdl"
                aria-expanded={expanded}
                aria-controls="wdc-dsheet"
                onClick={() => setOpen((o) => !o)}
              >
                <span className="in">
                  <span className="t">{detail}</span>
                  <span className="more" aria-hidden="true">
                    {expanded ? "Less" : "More"}
                  </span>
                </span>
              </button>
            ) : (
              <p className="legend">{LEGEND}</p>
            )}
            {expanded && (
              <div className="dsheet" id="wdc-dsheet" role="region" aria-label="Pairing detail">
                <p className="full">{detail}</p>
                <p className="legend">{LEGEND}</p>
                <button type="button" className="x" onClick={() => setOpen(false)}>
                  Close
                </button>
              </div>
            )}
          </div>
          <div className="mwrap">
            <table className="matrix">
              <thead>
                <tr>
                  <th scope="col">
                    <div className="ph">
                      <span className="n">{state.our}</span>
                      <span className="m">rows: ours {MID} columns: theirs</span>
                    </div>
                  </th>
                  {theirs.map((t) => (
                    <th key={t} scope="col">
                      <PlayerHead p={player(t)} locked={lockedThem.has(t)} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ours.map((u) => (
                  <tr key={u}>
                    <th scope="row">
                      <PlayerHead p={player(u)} locked={lockedUs.has(u)} />
                    </th>
                    {theirs.map((t) => {
                      const f = pair(u, t);
                      const v = f.points;
                      const fx =
                        f.matchup && Math.abs(f.points - f.noFaction) >= FACTION_MARK_POINTS
                          ? matchupLabel(f.matchup)
                          : "";
                      const hist = pairHistoryLabel(player(u), player(t));
                      const hx = hist && Math.abs(f.points - f.noHistory) >= HISTORY_MARK_POINTS;
                      const li = lockOf(u, t);
                      const locked = li >= 0;
                      const dim = !locked && (full || lockedUs.has(u) || lockedThem.has(t));
                      const best = !dim && !locked && bestRow[u]?.them === t;
                      const label = locked
                        ? `table ${li + 1}`
                        : best
                          ? `best for ${player(u).name.split(" ")[0]}`
                          : !dim && bestCol[t]?.us === u
                            ? "their worst"
                            : "";
                      return (
                        <td key={t}>
                          <button
                            type="button"
                            className={`cell ${cls(v)}${locked ? " lock" : ""}${dim ? " dim" : ""}${best ? " best" : ""}`}
                            disabled={dim}
                            aria-pressed={locked}
                            aria-label={`${u} vs ${t}, forecast ${v} to ${WDC_GAME_MAX - v}${locked ? ", locked" : ""}${fx ? `, ${fx}` : ""}${hist ? `, ${hist}` : ""}`}
                            title={hist || undefined}
                            onClick={() => {
                              setPicked({ opp: pairing.opp, us: u, them: t });
                              onToggleLock(u, t);
                            }}
                          >
                            <span className="num">
                              {v}
                              <span className="oth">-{WDC_GAME_MAX - v}</span>
                            </span>
                            {label && <small>{label}</small>}
                            {fx && (
                              <span className="fx" title={fx} aria-hidden="true">
                                F
                              </span>
                            )}
                            {hx && (
                              <span className="hx" title={hist} aria-hidden="true">
                                H
                              </span>
                            )}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
