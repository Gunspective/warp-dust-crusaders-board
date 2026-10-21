import { useEffect, useRef, useState, type FormEvent } from "react";
import { WDC_GAME_MAX, type WdcPlayer, type WdcTable } from "../../lib/wdc/types";

// Score pad (C7): a full-screen overlay with 0..20 as 21 keys, 7 to a row. One tap saves our points
// (theirs is 20 minus ours) and the board closes it; the coach PIN field rides inside the pad so a
// refused save never loses the screen the coach is on.

export type PinPromptView = { message: string };

export function PinForm({
  message,
  onSubmit,
  onCancel,
}: {
  message: string;
  onSubmit: (pin: string) => void;
  onCancel: () => void;
}) {
  const [pin, setPin] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pin.trim()) onSubmit(pin.trim());
  };
  return (
    <form className="pinbox" onSubmit={submit}>
      <p role="alert">{message}</p>
      <label htmlFor="wdc-pin">Coach PIN</label>
      <input
        id="wdc-pin"
        className="text-base"
        type="password"
        autoComplete="off"
        autoCapitalize="off"
        value={pin}
        onChange={(e) => setPin(e.target.value)}
      />
      <button type="submit">Save with PIN</button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

export function ScorePad({
  table,
  us,
  them,
  forecast,
  saving,
  pinPrompt,
  onPick,
  onClear,
  onClose,
  onPin,
  onPinCancel,
}: {
  table: WdcTable;
  us: WdcPlayer;
  them: WdcPlayer;
  forecast: number;
  saving: boolean;
  pinPrompt: PinPromptView | null;
  onPick: (points: number) => void;
  onClear: () => void;
  onClose: () => void;
  onPin: (pin: string) => void;
  onPinCancel: () => void;
}) {
  const keysRef = useRef<HTMLDivElement>(null);
  const start = table.coachScore ?? forecast;
  useEffect(() => {
    keysRef.current?.querySelector<HTMLButtonElement>(`[data-key="${start}"]`)?.focus();
    // Focus once when the pad opens; later score changes must not steal focus from the PIN field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table.t]);

  const keys = Array.from({ length: WDC_GAME_MAX + 1 }, (_, n) => n);
  return (
    <div className="pad" role="dialog" aria-modal="true" aria-label={`Score for table ${table.t}`}>
      <div className="head">
        <h2>
          Table {table.t} <span>score</span>
        </h2>
        <button type="button" className="x" onClick={onClose}>
          Back
        </button>
      </div>
      <div className="match">
        <div>
          <div className="n">{us.name}</div>
          <div className="f">
            {us.faction} {"·"} {us.elo}
          </div>
        </div>
        <div className="vs">VS</div>
        <div className="r">
          <div className="n">{them.name}</div>
          <div className="f">
            {them.faction} {"·"} {them.elo}
          </div>
        </div>
      </div>
      <p className="hint">
        Tap <b>our</b> points. Theirs fills in as {WDC_GAME_MAX} minus ours. Forecast was {forecast}
        -{WDC_GAME_MAX - forecast}.
      </p>
      <div className="keys" ref={keysRef}>
        {keys.map((n) => (
          <button
            key={n}
            type="button"
            data-key={n}
            disabled={saving}
            className={`${table.coachScore === n ? "sel" : ""}${forecast === n && table.coachScore == null ? " fc" : ""}`}
            title={`${n} to ${WDC_GAME_MAX - n}`}
            onClick={() => onPick(n)}
          >
            {n}
          </button>
        ))}
      </div>
      {pinPrompt && <PinForm message={pinPrompt.message} onSubmit={onPin} onCancel={onPinCancel} />}
      <div className="foot">
        <span>{saving ? "Saving..." : "One tap saves it and shows it on every screen."}</span>
        {table.coachScore != null && (
          <button type="button" className="clear" disabled={saving} onClick={onClear}>
            Clear score
          </button>
        )}
      </div>
    </div>
  );
}
