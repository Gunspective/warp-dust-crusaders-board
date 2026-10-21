// Browser client for the coach board API (docs/CONTRACT.md). The page codes against exactly these
// two names and shapes, which the board kept from its first home: getWdcBoard() and
// saveWdcCoachState({ data }). Each is one fetch against the Worker (src/worker/handler.ts); the
// behaviour lives in ../wdc/state.server.ts, which the Worker wraps.
import type { WdcBoardState, WdcCoachState } from "../wdc/types";

export type WdcSaveInput = {
  /** The whole coach document (C3). The server replaces the stored document with it. */
  coach: WdcCoachState;
  /** Plain-text PIN from the tablet; compared against the stored SHA-256 (KV `wdc.pin.sha256` or the secret). */
  pin: string;
};

export type WdcSaveResult =
  | { ok: true; state: WdcBoardState }
  | { ok: false; reason: "pin" | "pin-unset" | "invalid" | "unavailable"; message: string };

export const WDC_BOARD_PATH = "/api/board";
export const WDC_SAVE_PATH = "/api/save";

const REASONS = new Set(["pin", "pin-unset", "invalid", "unavailable"]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The merged board (BCP + coach state) for the configured event. Throws only when the Worker is unreachable or answers junk. */
export async function getWdcBoard(): Promise<WdcBoardState> {
  const res = await fetch(WDC_BOARD_PATH, {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Board request failed: HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!isRecord(body) || !isRecord(body.event) || !Array.isArray(body.rounds))
    throw new Error("Board reply is not a board");
  return body as unknown as WdcBoardState;
}

/**
 * Save the coach document (C3). PIN-gated; resolves to the JSON envelope the Worker answers with,
 * whatever the HTTP status (a refusal is a 4xx/5xx carrying {ok: false, reason, message}). Throws
 * only when the Worker cannot be reached or the reply is not an envelope; the page treats that as
 * "Could not reach the server".
 */
export async function saveWdcCoachState({ data }: { data: WdcSaveInput }): Promise<WdcSaveResult> {
  const res = await fetch(WDC_SAVE_PATH, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(data),
    cache: "no-store",
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Save reply is not JSON: HTTP ${res.status}`);
  }
  if (isRecord(body) && body.ok === true && isRecord(body.state))
    return { ok: true, state: body.state as unknown as WdcBoardState };
  if (
    isRecord(body) &&
    body.ok === false &&
    typeof body.reason === "string" &&
    REASONS.has(body.reason) &&
    typeof body.message === "string"
  )
    return {
      ok: false,
      reason: body.reason as "pin" | "pin-unset" | "invalid" | "unavailable",
      message: body.message,
    };
  throw new Error(`Save reply is not an envelope: HTTP ${res.status}`);
}
