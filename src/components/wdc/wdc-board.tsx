import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getWdcBoard, saveWdcCoachState } from "../../lib/api/wdc.functions";
import {
  WDC_GAME_MAX,
  WDC_GAMES,
  type WdcBoardState,
  type WdcCoachState,
} from "../../lib/wdc/types";
import {
  activePairing,
  applyCoach,
  clockLabel,
  forecastContext,
  historyLoaded,
  matchupSourceLabel,
  NUDGE_LIMIT,
  opponentShortlist,
  opponentsAll,
  pairingRound,
  playerIndex,
  stripFor,
  withPairing,
  withTable,
  withWeights,
} from "./model";
import { DEFAULT_WEIGHTS, type WdcWeights } from "../../lib/wdc/history";
import { PinForm, ScorePad } from "./wdc-pad";
import { PairingView } from "./wdc-pairing";
import { StripView, TableCards } from "./wdc-tables";
import { WeightsSheet } from "./wdc-weights";
import { WDC_CSS } from "./wdc-styles";

// The coach board shell: view and round state, saves (PIN-gated, C3/C7), the 30 second poll and the
// screen wake lock. Presentational pieces live in wdc-tables / wdc-pairing / wdc-pad, the arithmetic
// in model.ts.

const PIN_KEY = "wdc.pin";
const POLL_MS = 30_000;
const TOAST_MS = 2200;

function readPin(): string {
  try {
    return window.localStorage.getItem(PIN_KEY) ?? "";
  } catch {
    return "";
  }
}

function forgetPin() {
  try {
    window.localStorage.removeItem(PIN_KEY);
  } catch {
    // nothing stored to forget
  }
}

function writePin(pin: string) {
  try {
    window.localStorage.setItem(PIN_KEY, pin);
  } catch {
    // Private mode or blocked storage: the coach just types the PIN again next time.
  }
}

/** The Elo source for the footer sentence, which adds its own full stop: a source that already ends in
 * one (the Stat Check snapshot's does) would otherwise print "the file.. Grey Elo". */
export function eloSourceText(source: string): string {
  return source.trim().replace(/\.+$/, "") || "unknown";
}

type SaveOpts = {
  /** Toast shown once the server accepted the document. */
  label: string;
  /** Show the change before the server answers (nudges, pairing locks). */
  optimistic?: boolean;
  /** Runs after a successful save (closes the pad, jumps to the board). */
  onOk?: () => void;
};

type Pending = { coach: WdcCoachState; opts: SaveOpts };
type Prompt = { message: string; pending: Pending };
type Job = Pending & { pin?: string };

export function WdcBoard({ initial }: { initial: WdcBoardState }) {
  const [state, setState] = useState(initial);
  const [view, setView] = useState<"board" | "pairing">("board");
  const [viewRound, setViewRound] = useState(initial.currentRound);
  const [openTable, setOpenTable] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [showWeights, setShowWeights] = useState(false);
  const [saving, setSaving] = useState(false);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [toastMsg, setToastMsg] = useState("");
  const [toastOn, setToastOn] = useState(false);

  // Latest values for handlers that outlive a render (rapid taps, timers, awaited saves).
  const stateRef = useRef(initial);
  const baseRef = useRef(initial); // last board the server confirmed; what a refused optimistic edit rolls back to
  const promptRef = useRef<Prompt | null>(null);
  // One save in flight at a time; taps during it coalesce into the latest whole document (queuedRef).
  const inflightRef = useRef(false);
  const queuedRef = useRef<Job | null>(null);
  // Bumped when a save starts and when it lands: a poll that began under an older epoch is stale.
  const epochRef = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const put = useCallback((next: WdcBoardState) => {
    stateRef.current = next;
    setState(next);
  }, []);
  const confirm = useCallback(
    (next: WdcBoardState) => {
      baseRef.current = next;
      put(next);
    },
    [put],
  );
  const setPromptBoth = useCallback((p: Prompt | null) => {
    promptRef.current = p;
    setPrompt(p);
  }, []);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    setToastOn(true);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastOn(false), TOAST_MS);
  }, []);
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  // ---- live: poll while visible, never over an unsaved edit ----
  const refresh = useCallback(async () => {
    if (inflightRef.current || promptRef.current) return;
    const epoch = epochRef.current;
    try {
      const next = await getWdcBoard();
      if (epoch !== epochRef.current || inflightRef.current || promptRef.current) return;
      confirm(next);
    } catch {
      // A failed poll leaves the last good board on screen.
    }
  }, [confirm]);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // Keep the tablet awake while the board is up; tolerate refusal.
  useEffect(() => {
    let sentinel: { release?: () => Promise<void> } | null = null;
    let gone = false;
    const lock = () => {
      const wl = (
        navigator as Navigator & {
          wakeLock?: { request: (t: "screen") => Promise<typeof sentinel> };
        }
      ).wakeLock;
      if (!wl || typeof wl.request !== "function") return;
      wl.request("screen")
        .then((s) => {
          if (gone) void s?.release?.();
          else sentinel = s;
        })
        .catch(() => {});
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      lock();
      void refresh();
    };
    lock();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      gone = true;
      document.removeEventListener("visibilitychange", onVisible);
      void sentinel?.release?.();
    };
  }, [refresh]);

  // ---- saves ----
  // Every save sends the whole coach document. Taps while one is in flight replace the queued job
  // (each later document already carries the earlier taps); the queue drains when the reply lands.
  const send = useCallback(
    async (first: Job) => {
      let job: Job | null = first;
      while (job) {
        const { coach, opts, pin } = job;
        inflightRef.current = true;
        epochRef.current += 1;
        setSaving(true);
        let res: Awaited<ReturnType<typeof saveWdcCoachState>>;
        try {
          res = await saveWdcCoachState({ data: { coach, pin: pin ?? readPin() } });
        } catch {
          res = {
            ok: false,
            reason: "unavailable",
            message: "Could not reach the server. Try again.",
          };
        }
        epochRef.current += 1;
        const next: Job | null = queuedRef.current;
        queuedRef.current = null;

        if (res.ok) {
          if (pin) writePin(pin);
          baseRef.current = res.state;
          // A queued document is newer than this reply: keep its optimistic screen until it lands.
          if (!next) put(res.state);
          setPromptBoth(null);
          toast(opts.label);
          opts.onOk?.();
          job = next;
          continue;
        }
        inflightRef.current = false;
        setSaving(false);
        if (res.reason === "pin" || res.reason === "pin-unset") {
          // A stored PIN that is now refused is stale: forget it so it is not sent again.
          if (res.reason === "pin" && !pin) forgetPin();
          // The newest document waits behind the PIN; it already carries this one's change.
          const held = next ?? job;
          setPromptBoth({ message: res.message, pending: { coach: held.coach, opts: held.opts } });
          return;
        }
        // Refused for good (lockout, no database, bad shape): drop the queue, roll back, keep polling.
        setPromptBoth(null);
        put(baseRef.current);
        toast(res.message || "Could not save");
        return;
      }
      inflightRef.current = false;
      setSaving(false);
      void refresh();
    },
    [put, refresh, setPromptBoth, toast],
  );

  const save = useCallback(
    (coach: WdcCoachState, opts: SaveOpts, pin?: string) => {
      if (opts.optimistic) put(applyCoach(stateRef.current, coach));
      const job: Job = { coach, opts, pin };
      // While the PIN box is open, or before this tablet has a PIN, nothing is sent: the newest
      // document waits behind the box, so blank PINs never reach the server as guesses.
      if (
        pin === undefined &&
        !inflightRef.current &&
        (promptRef.current || (!readPin() && stateRef.current.pinSet))
      ) {
        setPromptBoth({
          message: promptRef.current?.message ?? "Enter the coach PIN",
          pending: { coach, opts },
        });
        return;
      }
      if (inflightRef.current) {
        queuedRef.current = job;
        return;
      }
      void send(job);
    },
    [put, send, setPromptBoth],
  );

  const submitPin = (pin: string) => {
    const p = promptRef.current;
    if (!p) return;
    save(p.pending.coach, { ...p.pending.opts, optimistic: false }, pin);
  };
  const cancelPin = () => {
    setPromptBoth(null);
    put(baseRef.current);
  };

  // ---- derived ----
  const player = useMemo(() => playerIndex(state), [state]);
  const round = state.rounds.find((r) => r.n === viewRound) ?? null;
  const ctx = useMemo(() => forecastContext(state), [state]);
  const strip = useMemo(() => (round ? stripFor(round, player, ctx) : null), [round, player, ctx]);
  const shortlist = useMemo(() => opponentShortlist(state), [state]);
  const everyone = useMemo(() => opponentsAll(state), [state]);
  const pairing = useMemo(() => activePairing(state), [state]);
  const pairRound = useMemo(() => pairingRound(state), [state]);
  const openTb =
    round && openTable != null ? (round.tables.find((t) => t.t === openTable) ?? null) : null;

  // ---- board actions ----
  const closePad = useCallback(() => {
    setOpenTable(null);
    if (promptRef.current) {
      setPromptBoth(null);
      put(baseRef.current);
    }
  }, [put, setPromptBoth]);

  useEffect(() => {
    if (openTable == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePad();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openTable, closePad]);

  const pick = (points: number | null) => {
    if (!round || !openTb) return;
    const label =
      points == null
        ? `Table ${openTb.t} cleared`
        : `Table ${openTb.t}: ${points}-${WDC_GAME_MAX - points} saved`;
    save(withTable(stateRef.current, round, openTb, { score: points }), {
      label,
      onOk: closePad,
    });
  };

  const nudge = (t: number, delta: -1 | 1) => {
    if (!round) return;
    const tb = round.tables.find((x) => x.t === t);
    if (!tb) return;
    // the forecast already sits at 0 or 20: a further nudge would change nothing on screen
    const shown = strip?.forecasts[round.tables.indexOf(tb)];
    if (shown != null && ((delta > 0 && shown >= WDC_GAME_MAX) || (delta < 0 && shown <= 0)))
      return;
    const next = Math.max(-NUDGE_LIMIT, Math.min(NUDGE_LIMIT, tb.nudge + delta));
    if (next === tb.nudge) return;
    save(withTable(stateRef.current, round, tb, { nudge: next }), {
      label: "Forecast saved",
      optimistic: true,
    });
  };

  // ---- forecast weights (C3) ----
  useEffect(() => {
    if (!showWeights) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowWeights(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [showWeights]);

  const setWeights = (next: WdcWeights, label: string) =>
    save(withWeights(stateRef.current, next), { label, optimistic: true });

  // ---- pairing actions ----
  const setOpponent = (opp: string) =>
    save(withPairing(stateRef.current, { opp, locks: [] }), {
      label: "Opponent saved",
      optimistic: true,
    });

  const toggleLock = (us: string, them: string) => {
    const cur = activePairing(stateRef.current);
    const i = cur.locks.findIndex((l) => l.us === us && l.them === them);
    // The server stores at most eight locks; a ninth rostered player sits out.
    if (i < 0 && cur.locks.length >= WDC_GAMES) return;
    const locks = i >= 0 ? cur.locks.filter((_, k) => k !== i) : [...cur.locks, { us, them }];
    save(withPairing(stateRef.current, { opp: cur.opp, locks }), {
      label: i >= 0 ? "Pairing unlocked" : `Locked as table ${locks.length}`,
      optimistic: true,
    });
  };

  const clearLocks = () =>
    save(withPairing(stateRef.current, { opp: pairing.opp, locks: [] }), {
      label: "Pairings cleared",
      optimistic: true,
    });

  const setTables = () => {
    if (pairRound == null) return;
    const n = pairRound;
    save(withPairing(stateRef.current, pairing), {
      label: `Round ${n} tables set`,
      onOk: () => {
        setViewRound(n);
        setView("board");
      },
    });
  };

  const stale = state.stale;
  const staleAt = clockLabel(state.bcpAt);

  return (
    <div className="wdc">
      <style>{WDC_CSS}</style>
      <header className="top">
        <h1>
          Warp Dust <span>Coach Board</span>
        </h1>
        <div className="hdr-r">
          {view === "board" && (
            <nav className="rounds" aria-label="Round">
              {Array.from({ length: state.event.rounds }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  type="button"
                  disabled={!state.rounds.some((r) => r.n === n)}
                  aria-current={n === viewRound ? "true" : undefined}
                  onClick={() => setViewRound(n)}
                >
                  R{n}
                </button>
              ))}
            </nav>
          )}
          <div className="views" role="tablist" aria-label="View">
            {(["board", "pairing"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                aria-current={view === v ? "true" : "false"}
                onClick={() => setView(v)}
              >
                {v === "board" ? "Board" : "Pairing"}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="wbtn"
            aria-haspopup="dialog"
            aria-expanded={showWeights}
            onClick={() => setShowWeights((v) => !v)}
          >
            Weights
          </button>
        </div>
      </header>
      {stale && (
        <p className="stale" role="status">
          {staleAt ? `BCP unreachable since ${staleAt}` : "BCP unreachable"}. Showing the last good
          board.
        </p>
      )}
      <main className="app">
        {view === "pairing" ? (
          <PairingView
            state={state}
            player={player}
            pairing={pairing}
            pairRound={pairRound}
            shortlist={shortlist}
            everyone={everyone}
            showAll={showAll}
            onToggleShowAll={() => setShowAll((v) => !v)}
            onOpponent={setOpponent}
            onToggleLock={toggleLock}
            onClear={clearLocks}
            onSetTables={setTables}
          />
        ) : round && strip ? (
          <>
            <StripView round={round} strip={strip} player={player} />
            <TableCards
              round={round}
              strip={strip}
              player={player}
              onOpen={setOpenTable}
              onNudge={nudge}
            />
            <p className="readonly">
              Elo: {eloSourceText(state.eloSource)}. Grey Elo means no rating was found and 1400 is
              assumed. Forecasts also use {matchupSourceLabel()}
              {historyLoaded()
                ? " and BCP 11th edition player history (form and results vs each army)"
                : ""}
              , scaled by Weights.
            </p>
          </>
        ) : (
          <div className="empty">
            Round {viewRound} pairings are not posted yet. They appear here the moment they are
            loaded.
          </div>
        )}
      </main>

      {openTb && round && strip && (
        <ScorePad
          table={openTb}
          us={player(openTb.us)}
          them={player(openTb.them)}
          forecast={strip.forecasts[round.tables.indexOf(openTb)]}
          saving={saving}
          pinPrompt={prompt ? { message: prompt.message } : null}
          onPick={pick}
          onClear={() => pick(null)}
          onClose={closePad}
          onPin={submitPin}
          onPinCancel={cancelPin}
        />
      )}
      {showWeights && (
        <WeightsSheet
          weights={ctx.weights ?? DEFAULT_WEIGHTS}
          onChange={(next) => setWeights(next, "Weights saved")}
          onReset={() => setWeights(DEFAULT_WEIGHTS, "Weights reset")}
          onClose={() => setShowWeights(false)}
        />
      )}
      {!openTb && prompt && (
        <div className="pinsheet">
          <PinForm message={prompt.message} onSubmit={submitPin} onCancel={cancelPin} />
        </div>
      )}
      <div className={`toast${toastOn ? " on" : ""}`} role="status" aria-live="polite">
        {toastMsg}
      </div>
    </div>
  );
}
