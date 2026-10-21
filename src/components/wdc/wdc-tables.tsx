import type { MouseEvent } from "react";
import {
  WDC_DRAW,
  WDC_GAME_MAX,
  WDC_GAMES,
  WDC_WIN,
  type WdcPlayer,
  type WdcRound,
} from "../../lib/wdc/types";
import { averageElo, listHref, tableScore, verdictFor, type Strip } from "./model";

// Board view: the team strip (C4) and the table cards.

const MID = "·";

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function StripView({
  round,
  strip,
  player,
}: {
  round: WdcRound;
  strip: Strip;
  player: (name: string) => WdcPlayer;
}) {
  const pred = verdictFor(strip.predicted);
  const proj = verdictFor(strip.projected);
  const need = strip.need;
  const theirAvg = averageElo(
    round.tables.map((t) => t.them),
    player,
  );
  const ourAvg = averageElo(
    round.tables.map((t) => t.us),
    player,
  );
  return (
    <section className="strip" aria-label="Team status">
      <div className="vs">
        <span className="eyebrow">Round {round.n} vs</span>
        <h2>{round.opp}</h2>
        <span className="oppelo num">
          their avg Elo {theirAvg} {MID} ours {ourAvg}
        </span>
      </div>
      <div className="stat">
        <div className="lab">Predicted</div>
        <div className="val num">
          {strip.predicted}
          <span className={`tag lead ${pred.cls}`}>{pred.label}</span>
        </div>
        <div className="sub">Elo, faction and history before any result</div>
      </div>
      <div className="stat">
        <div className="lab">Locked in</div>
        <div className="val num">{strip.locked}</div>
        <div className="sub">
          {strip.scored} of {strip.total} tables done
        </div>
      </div>
      <div className="stat">
        <div className="lab">Projected</div>
        <div className="val num">
          {strip.projected}
          <span className={`tag lead ${proj.cls}`}>{proj.label}</span>
        </div>
        <div className="sub">results so far + forecast for the rest</div>
      </div>
      <div className="stat">
        <div className="lab">Line</div>
        <div className="val num">{WDC_WIN}</div>
        <div className="sub">
          of {WDC_GAMES * WDC_GAME_MAX} wins {MID} {WDC_DRAW} draws
        </div>
      </div>
      <div className="need">
        {need.kind === "final" && (
          <>
            <span>
              Final: <b>{need.locked}</b> to <b>{need.theirs}</b>
            </span>
            <span className={`tag ${need.verdict.cls}`}>{need.verdict.label}</span>
          </>
        )}
        {need.kind === "won" && (
          <>
            <span className="tag win">Match won</span>
            <span>
              {need.locked} locked with {plural(need.left, "table")} to play
            </span>
          </>
        )}
        {need.kind === "out" && (
          <>
            <span className="tag loss">Out of reach</span>
            <span>
              Best case {need.best} of {WDC_GAMES * WDC_GAME_MAX}
            </span>
          </>
        )}
        {need.kind === "open" && (
          <>
            <span>
              To win: <b>{need.toWin}</b> more from {plural(need.left, "table")} (
              <b>{need.perGame}</b> per game)
            </span>
            <span>
              To draw: <b>{need.toDraw}</b>
            </span>
            {need.drawCeiling && <span className="tag draw">Draw is the ceiling</span>}
          </>
        )}
      </div>
    </section>
  );
}

function Meta({ p }: { p: WdcPlayer }) {
  return (
    <div className="meta">
      <span className={`elo num${p.eloKnown ? "" : " unk"}`}>{p.elo}</span>
      <span>{p.faction}</span>
      <span>{p.dispo}</span>
    </div>
  );
}

const stop = (e: MouseEvent) => e.stopPropagation();

export function TableCards({
  round,
  strip,
  player,
  onOpen,
  onNudge,
}: {
  round: WdcRound;
  strip: Strip;
  player: (name: string) => WdcPlayer;
  onOpen: (t: number) => void;
  onNudge: (t: number, delta: -1 | 1) => void;
}) {
  return (
    <section className="grid" aria-label="Tables">
      {round.tables.map((tb, i) => {
        const us = player(tb.us);
        const them = player(tb.them);
        const p = strip.forecasts[i];
        const usL = listHref(us);
        const themL = listHref(them);
        const score = tableScore(tb);
        const posted = tb.bcpScore != null;
        const done = score != null;
        return (
          <article
            key={tb.t}
            className={`card${done ? " scored" : ""}${posted ? " posted" : ""}`}
            data-t={tb.t}
            onClick={() => {
              if (!posted) onOpen(tb.t);
            }}
          >
            <div className="tno">
              <span className="eyebrow">Table {tb.t}</span>
              <span>
                {themL ? (
                  <a
                    className="listlink them"
                    href={themL}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={stop}
                  >
                    Their list {"↗"}
                  </a>
                ) : (
                  <span className="listlink them none">No list</span>
                )}
              </span>
            </div>
            <div className="side us">
              <div className="who" title={us.name}>
                {us.name}
              </div>
              <Meta p={us} />
            </div>
            <button
              type="button"
              className="score"
              disabled={posted}
              aria-label={
                posted
                  ? `Table ${tb.t} posted on BCP: ${score} to ${WDC_GAME_MAX - (score ?? 0)}`
                  : done
                    ? `Change score for table ${tb.t}`
                    : `Enter score for table ${tb.t}`
              }
            >
              {done ? (
                <>
                  <span className="big num">
                    {score}
                    <small> - {WDC_GAME_MAX - (score ?? 0)}</small>
                  </span>
                  <span className="lab">{posted ? "BCP final" : "final"}</span>
                </>
              ) : (
                <>
                  <span className="big fc num">
                    {p}
                    <small> - {WDC_GAME_MAX - p}</small>
                  </span>
                  <span className="lab">tap to score</span>
                </>
              )}
            </button>
            <div className="side them">
              <div className="who" title={them.name}>
                {them.name}
              </div>
              <Meta p={them} />
            </div>
            <div className="pred">
              <span>
                Forecast{" "}
                <b className="num">
                  {p}-{WDC_GAME_MAX - p}
                </b>
              </span>
              <span className="bar" aria-hidden="true">
                <i style={{ width: `${(p / WDC_GAME_MAX) * 100}%` }} />
              </span>
              {usL && (
                <a
                  className="listlink"
                  href={usL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={stop}
                >
                  Our list
                </a>
              )}
              <span className="nudge" role="group" aria-label="Coach nudge">
                <button
                  type="button"
                  aria-label={`Forecast one lower for table ${tb.t}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onNudge(tb.t, -1);
                  }}
                >
                  {"−"}
                </button>
                <button
                  type="button"
                  aria-label={`Forecast one higher for table ${tb.t}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onNudge(tb.t, 1);
                  }}
                >
                  +
                </button>
              </span>
            </div>
          </article>
        );
      })}
    </section>
  );
}
