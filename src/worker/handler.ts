// The coach board Worker's request handler (contract: docs/CONTRACT.md); index.ts is the module
// entry. Kept apart because workerd accepts only handlers as a Worker module's exports. Three jobs:
//   GET  /api/board  the merged board (loadBoard): BCP + the coach document + Elo. Never fails on a
//                    BCP outage; answers the last good snapshot with stale true instead (C2).
//   POST /api/save   the PIN-gated save of the whole coach document (saveCoach, C3), answering the
//                    JSON envelope {ok: true, state} or {ok: false, reason, message}.
//   anything else    the built board from ./dist (Workers static assets), with the single-page
//                    fallback to index.html.
// Every response carries the security headers (headers.ts). Storage is the Workers KV binding
// WDC_KV; the coach PIN comes from KV `wdc.pin.sha256` or the secret WDC_PIN_SHA256, and the secret
// WDC_PIN_OFF = "1" switches the PIN off (README.md, "Coach PIN").
import eloSnapshot from "../lib/wdc/elo-snapshot.json";
import type { BcpFetch } from "../lib/wdc/bcp.server";
import type { EloSnapshot } from "../lib/wdc/elo";
import {
  loadBoard,
  saveCoach,
  WDC_SAVE_MAX_BYTES,
  type LoadDeps,
  type SaveResult,
  type WdcKv,
} from "../lib/wdc/state.server";
import { withSecurityHeaders } from "./headers";

/** The slice of the static-assets binding the Worker uses. */
export type AssetFetcher = { fetch(request: Request): Promise<Response> };

export type Env = {
  ASSETS?: AssetFetcher;
  WDC_KV?: WdcKv;
  /** Hex SHA-256 of the coach PIN; used when KV has no `wdc.pin.sha256`. */
  WDC_PIN_SHA256?: string;
  /** "1" switches the coach PIN off: saves need no PIN and are not throttled. */
  WDC_PIN_OFF?: string;
};

/** Test seams: the BCP fetch and the KV retry wait. Production passes nothing. */
export type HandlerOptions = { fetchImpl?: BcpFetch; kvRetryMs?: number };

export const BOARD_PATH = "/api/board";
export const SAVE_PATH = "/api/save";

// A body this far past the 64 KB document cap is refused before it is parsed; the exact cap is
// checkSaveInput's (UTF-8 JSON of the parsed input) inside saveCoach.
const BODY_SLACK_BYTES = 4 * 1024;

const json = (body: unknown, status = 200, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });

type Refusal = Extract<SaveResult, { ok: false }>;

const refusal = (reason: Refusal["reason"], message: string, status: number): Response =>
  json({ ok: false, reason, message } satisfies Refusal, status);

/** HTTP status for a save envelope; the body is the envelope either way. */
const saveStatus = (res: SaveResult): number => {
  if (res.ok) return 200;
  switch (res.reason) {
    case "invalid":
      return res.message === "Coach document too large" ? 413 : 400;
    case "pin":
    case "pin-unset":
      return 403;
    case "unavailable":
      return res.message === "Too many tries" ? 429 : 503;
  }
};

const deps = (env: Env, opts: HandlerOptions): LoadDeps => ({
  elo: eloSnapshot as unknown as EloSnapshot,
  pinHash: env.WDC_PIN_SHA256,
  pinOff: env.WDC_PIN_OFF === "1",
  fetchImpl: opts.fetchImpl,
  kvRetryMs: opts.kvRetryMs,
});

const notAllowed = (allow: string): Response =>
  json({ ok: false, reason: "method", message: "Method not allowed" }, 405, { allow });

async function board(request: Request, env: Env, opts: HandlerOptions): Promise<Response> {
  if (request.method !== "GET") return notAllowed("GET");
  return json(await loadBoard(env.WDC_KV ?? null, deps(env, opts)));
}

async function save(request: Request, env: Env, opts: HandlerOptions): Promise<Response> {
  if (request.method !== "POST") return notAllowed("POST");
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type))
    return refusal("invalid", "Send the coach document as application/json", 415);
  const cap = WDC_SAVE_MAX_BYTES + BODY_SLACK_BYTES;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > cap)
    return refusal("invalid", "Coach document too large", 413);
  let text: string;
  try {
    text = await request.text();
  } catch {
    return refusal("invalid", "Invalid coach document", 400);
  }
  if (new TextEncoder().encode(text).length > cap)
    return refusal("invalid", "Coach document too large", 413);
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return refusal("invalid", "Invalid coach document", 400);
  }
  const res = await saveCoach(env.WDC_KV ?? null, input, deps(env, opts));
  return json(res, saveStatus(res));
}

/** A path whose last segment has no extension: a page route, so it falls back to index.html. */
const isPageRoute = (pathname: string): boolean => !/\.[a-z0-9]+$/i.test(pathname);

/** Vite's build output: every file name under /assets/ carries a content hash, so it never changes. */
export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

/**
 * Marks a real /assets/* file (200 or 304) cacheable for a year. The asset layer answers a missing
 * /assets/ path with index.html (single-page fallback), so an HTML reply keeps its own revalidating
 * header, as does everything outside /assets/ (index.html: max-age=0, must-revalidate).
 */
const withAssetCaching = (pathname: string, res: Response): Response => {
  if (!pathname.startsWith("/assets/") || (res.status !== 200 && res.status !== 304)) return res;
  if (/^text\/html\b/i.test(res.headers.get("content-type") ?? "")) return res;
  const out = new Response(res.body, res);
  out.headers.set("cache-control", IMMUTABLE_CACHE);
  return out;
};

async function assets(request: Request, env: Env): Promise<Response> {
  if (!env.ASSETS) return new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  const res = withAssetCaching(url.pathname, await env.ASSETS.fetch(request));
  // The asset layer already falls back to index.html (not_found_handling in wrangler.jsonc); this
  // keeps the single-page fallback if that setting is ever lost. "/" because the asset layer
  // redirects /index.html to it.
  if (
    res.status === 404 &&
    (request.method === "GET" || request.method === "HEAD") &&
    isPageRoute(url.pathname)
  )
    return env.ASSETS.fetch(new Request(new URL("/", url), { method: request.method }));
  return res;
}

async function route(request: Request, env: Env, opts: HandlerOptions): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === BOARD_PATH) return board(request, env, opts);
  if (pathname === SAVE_PATH) return save(request, env, opts);
  if (pathname === "/api" || pathname.startsWith("/api/"))
    return json({ ok: false, reason: "not-found", message: "Not found" }, 404);
  return assets(request, env);
}

/** The whole Worker: route, never throw, and put the security headers on whatever comes back. */
export async function handleRequest(
  request: Request,
  env: Env,
  opts: HandlerOptions = {},
): Promise<Response> {
  let res: Response;
  try {
    res = await route(request, env, opts);
  } catch {
    res = json({ ok: false, reason: "unavailable", message: "Server error" }, 500);
  }
  return withSecurityHeaders(res);
}
