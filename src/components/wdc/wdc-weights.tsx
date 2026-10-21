import { useEffect, useRef } from "react";
import {
  DEFAULT_WEIGHTS,
  WEIGHT_MAX,
  WEIGHT_MIN,
  WEIGHT_STEP,
  type WdcWeights,
} from "../../lib/wdc/history";
import { weightLabel } from "./model";

// Forecast weights sheet (C3 `weights`, docs/HISTORY.md): an overlay like the PIN sheet, so the
// one-screen tablet layout never changes height. Each tap saves the whole coach document through
// the board's save queue.

const WEIGHT_ROWS: Array<{ key: keyof WdcWeights; label: string; desc: string }> = [
  { key: "faction", label: "Faction matchups", desc: "Stat Check army against army win rates." },
  {
    key: "form",
    label: "11th edition form",
    desc: "Each player's BCP 40K record in 11th edition (since ATC Tennessee).",
  },
  {
    key: "history",
    label: "11th vs this army",
    desc: "How each player does into this army in 11th, against their norm.",
  },
];

const same = (a: WdcWeights, b: WdcWeights) =>
  a.faction === b.faction && a.form === b.form && a.history === b.history;

export function WeightsSheet({
  weights,
  onChange,
  onReset,
  onClose,
}: {
  weights: WdcWeights;
  onChange: (next: WdcWeights) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const doneRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    doneRef.current?.focus();
  }, []);

  const step = (key: keyof WdcWeights, dir: -1 | 1) => {
    const v = Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, weights[key] + dir * WEIGHT_STEP));
    if (v !== weights[key]) onChange({ ...weights, [key]: v });
  };

  return (
    <div className="wsheet" onClick={onClose}>
      <div
        className="wpanel"
        role="dialog"
        aria-modal="true"
        aria-label="Forecast weights"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="whead">
          <h2>
            Forecast <span>weights</span>
          </h2>
          <button type="button" className="x" ref={doneRef} onClick={onClose}>
            Done
          </button>
        </div>
        <ul className="wrows">
          {WEIGHT_ROWS.map((r) => {
            const v = weights[r.key];
            return (
              <li key={r.key} className="wrow">
                <div className="wtxt">
                  <span className="wl">{r.label}</span>
                  <span className="wd">{r.desc}</span>
                </div>
                <div className="wctl" role="group" aria-label={`${r.label} weight`}>
                  <button
                    type="button"
                    aria-label={`Lower ${r.label} weight`}
                    disabled={v <= WEIGHT_MIN}
                    onClick={() => step(r.key, -1)}
                  >
                    {"−"}
                  </button>
                  <output className="wv num" aria-live="polite">
                    {weightLabel(v)}
                  </output>
                  <button
                    type="button"
                    aria-label={`Raise ${r.label} weight`}
                    disabled={v >= WEIGHT_MAX}
                    onClick={() => step(r.key, 1)}
                  >
                    +
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="wfoot">
          <span>0x turns a factor off, 2.0x doubles it.</span>
          <button
            type="button"
            className="wreset"
            disabled={same(weights, DEFAULT_WEIGHTS)}
            onClick={onReset}
          >
            Reset to defaults
          </button>
        </div>
      </div>
    </div>
  );
}
