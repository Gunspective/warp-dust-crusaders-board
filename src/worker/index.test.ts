// @vitest-environment node
//
// The Worker (src/worker/handler.ts behind the index.ts entry): routing, the two endpoints, the save envelope and its HTTP
// statuses, the PIN switches, the throttle through HTTP, the asset fallback and the security headers
// on every response. KV is a Map fake, BCP the real TEO-8 fixtures through an injected fetch, and
// the static-assets binding a fake that knows /, /index.html and one hashed bundle.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import eventFixture from "../lib/wdc/fixtures/event.json";
import standingsFixture from "../lib/wdc/fixtures/standings.json";
import round1PairingFixture from "../lib/wdc/fixtures/round1-pairing.json";
import round1TeamPairingFixture from "../lib/wdc/fixtures/round1-teampairing.json";
import { resetBcpCacheForTests, type BcpFetch } from "../lib/wdc/bcp.server";
import {
  emptyCoach,
  WDC_PIN_FAILS_KEY,
  WDC_PIN_KEY,
  wdcSnapshotKey,
  wdcStateKey,
  type WdcKv,
} from "../lib/wdc/state.server";
import type { WdcBoardState, WdcCoachState } from "../lib/wdc/types";
import worker from "./index";
import { handleRequest, type AssetFetcher, type Env, type HandlerOptions } from "./handler";
import { CONTENT_SECURITY_POLICY } from "./headers";

const EVENT = "JkPs5aELBHPh";
const ORIGIN = "https://board.example";
const hashOf = (pin: string) => createHash("sha256").update(pin).digest("hex");

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fixtureFetch = () =>
  vi.fn<BcpFetch>(async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/teamPlayers")) return json(standingsFixture);
    if (u.pathname.endsWith("/pairings")) {
      if (u.searchParams.get("round") !== "1") return json({ active: [], deleted: [] });
      return json(
        u.searchParams.get("pairingType") === "TeamPairing"
          ? round1TeamPairingFixture
          : round1PairingFixture,
      );
    }
    return json(eventFixture);
  });

const offline: BcpFetch = async () => {
  throw new TypeError("network down");
};

const fakeKv = (seed: Record<string, string> = {}) => {
  const rows = new Map<string, string>(Object.entries(seed));
  const kv: WdcKv = {
    async get(key) {
      return rows.get(key) ?? null;
    },
    async put(key, value) {
      rows.set(key, value);
    },
  };
  return { kv, rows };
};

const INDEX = '<!doctype html><html><head><title>Warp Dust Coach Board</title></head><body><div id="root"></div></body></html>';

// What Workers static assets sends on every file (seen on the live board, 2026-10-19).
const ASSET_LAYER_CACHE = "public, max-age=0, must-revalidate";

/** The static-assets binding: three files, 404 for anything else (no SPA mode, to test the Worker's own fallback). */
const fakeAssets = (): AssetFetcher & { seen: string[] } => {
  const seen: string[] = [];
  return {
    seen,
    async fetch(request: Request) {
      const { pathname } = new URL(request.url);
      seen.push(pathname);
      if (pathname === "/" || pathname === "/index.html")
        return new Response(INDEX, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": ASSET_LAYER_CACHE },
        });
      if (pathname === "/assets/index-abc123.js")
        return new Response("console.log(1)", {
          headers: { "content-type": "text/javascript", "cache-control": ASSET_LAYER_CACHE },
        });
      return new Response("Not Found", { status: 404 });
    },
  };
};

const env = (o: Partial<Env> & { seed?: Record<string, string> } = {}) => {
  const { kv, rows } = fakeKv(o.seed);
  const assets = fakeAssets();
  const e: Env = { ASSETS: assets, WDC_KV: kv, ...o };
  delete (e as { seed?: unknown }).seed;
  return { env: e, rows, assets };
};

const opts = (fetchImpl: BcpFetch = fixtureFetch()): HandlerOptions => ({ fetchImpl, kvRetryMs: 0 });

const get = (path: string, init: RequestInit = {}) => new Request(`${ORIGIN}${path}`, init);

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/save`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const doc = (): WdcCoachState => ({
  ...emptyCoach(),
  rounds: { "1": { players: { "steve trimble": { score: 9, nudge: 2 } } } },
});

const expectSecurityHeaders = (res: Response) => {
  expect(res.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
};

beforeEach(() => {
  resetBcpCacheForTests();
});

describe("GET /api/board", () => {
  it("answers the merged live board as JSON, no-store", async () => {
    const { env: e, rows } = env();
    const res = await handleRequest(get("/api/board"), e, opts());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const board = (await res.json()) as WdcBoardState;
    expect(board.event.id).toBe(EVENT);
    expect(board.our).toBe("Warp Dust Crusaders");
    expect(board.stale).toBe(false);
    expect(board.rounds).toHaveLength(1);
    expect(board.pinSet).toBe(false);
    expect(rows.has(wdcSnapshotKey(EVENT))).toBe(true);
  });

  it("answers a stale board from the stored snapshot when BCP is unreachable", async () => {
    const { env: e } = env();
    await handleRequest(get("/api/board"), e, opts());
    resetBcpCacheForTests();
    const res = await handleRequest(get("/api/board"), e, opts(offline));
    expect(res.status).toBe(200);
    const board = (await res.json()) as WdcBoardState;
    expect(board.stale).toBe(true);
    expect(board.rounds).toHaveLength(1);
  });

  it("answers a minimal stale board with no network and an empty KV, never an error", async () => {
    const { env: e } = env();
    const res = await handleRequest(get("/api/board"), e, opts(offline));
    expect(res.status).toBe(200);
    const board = (await res.json()) as WdcBoardState;
    expect(board).toMatchObject({ stale: true, rounds: [], teams: {}, bcpAt: null });
    expect(board.event.id).toBe(EVENT);
  });

  it("answers without a KV binding at all", async () => {
    const { env: e } = env({ WDC_KV: undefined });
    const res = await handleRequest(get("/api/board"), e, opts(offline));
    expect(res.status).toBe(200);
    expect(((await res.json()) as WdcBoardState).stale).toBe(true);
  });

  it("reads the event and team from KV wdc.event and wdc.team", async () => {
    const { env: e } = env({ seed: { "wdc.event": "OTHER123", "wdc.team": "Calamity Inc." } });
    const board = (await (
      await handleRequest(get("/api/board"), e, opts(offline))
    ).json()) as WdcBoardState;
    expect(board.event.id).toBe("OTHER123");
    expect(board.our).toBe("Calamity Inc.");
  });

  it("reports pinSet from the secret, and false when WDC_PIN_OFF is 1", async () => {
    const on = env({ WDC_PIN_SHA256: hashOf("4321") });
    expect(
      ((await (await handleRequest(get("/api/board"), on.env, opts())).json()) as WdcBoardState)
        .pinSet,
    ).toBe(true);
    const off = env({ WDC_PIN_SHA256: hashOf("4321"), WDC_PIN_OFF: "1" });
    expect(
      ((await (await handleRequest(get("/api/board"), off.env, opts())).json()) as WdcBoardState)
        .pinSet,
    ).toBe(false);
  });

  it("refuses other methods with 405 and Allow: GET", async () => {
    const { env: e } = env();
    const res = await handleRequest(get("/api/board", { method: "POST", body: "{}" }), e, opts());
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
    expectSecurityHeaders(res);
  });
});

describe("POST /api/save", () => {
  const hash = hashOf("1234");

  it("refuses with pin-unset (403) when no PIN is configured, and stores nothing", async () => {
    const { env: e, rows } = env();
    const res = await handleRequest(post({ coach: doc(), pin: "1234" }), e, opts());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, reason: "pin-unset", message: "Coach PIN not set" });
    expect(rows.has(wdcStateKey(EVENT))).toBe(false);
  });

  it("saves with the PIN whose hash is the WDC_PIN_SHA256 secret, and answers the merged board", async () => {
    const { env: e, rows } = env({ WDC_PIN_SHA256: hash });
    const res = await handleRequest(post({ coach: doc(), pin: "1234" }), e, opts());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { ok: true; state: WdcBoardState };
    expect(body.ok).toBe(true);
    expect(body.state.coach).toEqual(doc());
    expect(body.state.pinSet).toBe(true);
    expect(JSON.parse(rows.get(wdcStateKey(EVENT))!)).toEqual(doc());
    // the secret never lands in KV
    for (const v of rows.values()) expect(v).not.toContain(hash);
  });

  it("uses a KV wdc.pin.sha256 hash over the secret", async () => {
    const { env: e } = env({ WDC_PIN_SHA256: hash, seed: { [WDC_PIN_KEY]: hashOf("9876") } });
    expect((await handleRequest(post({ coach: doc(), pin: "1234" }), e, opts())).status).toBe(403);
    expect((await handleRequest(post({ coach: doc(), pin: "9876" }), e, opts())).status).toBe(200);
  });

  it("answers a wrong PIN with 403 Wrong PIN and counts it", async () => {
    const { env: e, rows } = env({ WDC_PIN_SHA256: hash });
    const res = await handleRequest(post({ coach: doc(), pin: "0000" }), e, opts());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, reason: "pin", message: "Wrong PIN" });
    expect(JSON.parse(rows.get(WDC_PIN_FAILS_KEY)!).count).toBe(1);
    expect(rows.has(wdcStateKey(EVENT))).toBe(false);
  });

  it("locks after 10 wrong PINs with 429 Too many tries, correct PIN included", async () => {
    const { env: e, rows } = env({ WDC_PIN_SHA256: hash });
    for (let i = 0; i < 10; i++) {
      const res = await handleRequest(post({ coach: doc(), pin: `bad${i}` }), e, opts());
      expect(res.status).toBe(403);
    }
    const locked = await handleRequest(post({ coach: doc(), pin: "1234" }), e, opts());
    expect(locked.status).toBe(429);
    expect(await locked.json()).toEqual({
      ok: false,
      reason: "unavailable",
      message: "Too many tries",
    });
    expect(rows.has(wdcStateKey(EVENT))).toBe(false);
    expectSecurityHeaders(locked);
  });

  it("WDC_PIN_OFF=1 saves with no PIN and ignores a lockout; any other value keeps the PIN", async () => {
    const seed = { [WDC_PIN_FAILS_KEY]: JSON.stringify({ count: 99, windowStart: Date.now() }) };
    const off = env({ WDC_PIN_SHA256: hash, WDC_PIN_OFF: "1", seed });
    const res = await handleRequest(post({ coach: doc(), pin: "" }), off.env, opts());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { state: WdcBoardState }).state.pinSet).toBe(false);
    const notOff = env({ WDC_PIN_SHA256: hash, WDC_PIN_OFF: "true" });
    expect((await handleRequest(post({ coach: doc(), pin: "" }), notOff.env, opts())).status).toBe(
      403,
    );
  });

  it.each([
    ["not JSON", "{coach:", 400, "Invalid coach document"],
    ["JSON null", "null", 400, "Invalid coach document"],
    ["no pin", { coach: doc() }, 400, "Invalid coach document"],
    ["a numeric pin", { coach: doc(), pin: 1234 }, 400, "Invalid coach document"],
    [
      "a score out of range",
      { coach: { ...doc(), rounds: { "1": { players: { a: { score: 25, nudge: 0 } } } } }, pin: "1234" },
      400,
      "Invalid coach document",
    ],
    ["a PIN over 64 characters", { coach: doc(), pin: "1".repeat(65) }, 400, "Invalid coach document"],
  ])("answers invalid for %s", async (_l, body, status, message) => {
    const { env: e, rows } = env({ WDC_PIN_SHA256: hash });
    const res = await handleRequest(post(body), e, opts());
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ ok: false, reason: "invalid", message });
    expect(rows.size).toBe(0);
  });

  it("caps the document at 64 KB (413), measured on the parsed input", async () => {
    const { env: e, rows } = env({ WDC_PIN_SHA256: hash });
    // just over the cap but inside the body slack: refused by checkSaveInput
    const over = { coach: { ...doc(), junk: "x".repeat(64 * 1024) }, pin: "1234" };
    const res = await handleRequest(post(over), e, opts());
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      ok: false,
      reason: "invalid",
      message: "Coach document too large",
    });
    // far over: refused on the body length before parsing
    const huge = await handleRequest(post("x".repeat(200 * 1024)), e, opts());
    expect(huge.status).toBe(413);
    // and on a declared Content-Length alone
    const declared = await handleRequest(
      post({ coach: doc(), pin: "1234" }, { "content-length": String(1024 * 1024) }),
      e,
      opts(),
    );
    expect(declared.status).toBe(413);
    expect(rows.size).toBe(0);
  });

  it("wants application/json (415 otherwise)", async () => {
    const { env: e } = env({ WDC_PIN_SHA256: hash });
    const res = await handleRequest(
      post({ coach: doc(), pin: "1234" }, { "content-type": "text/plain" }),
      e,
      opts(),
    );
    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("answers unavailable (503) with no KV binding", async () => {
    const { env: e } = env({ WDC_PIN_SHA256: hash, WDC_KV: undefined });
    const res = await handleRequest(post({ coach: doc(), pin: "1234" }), e, opts());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      reason: "unavailable",
      message: "Board storage is not available",
    });
  });

  it("refuses GET with 405 and Allow: POST", async () => {
    const { env: e } = env();
    const res = await handleRequest(get("/api/save"), e, opts());
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("round-trips through the browser client's request shape", async () => {
    const { env: e } = env({ WDC_PIN_SHA256: hash });
    // exactly what saveWdcCoachState sends: the {coach, pin} object as the JSON body
    const saved = await handleRequest(post({ coach: doc(), pin: " 1234 " }), e, opts());
    expect(saved.status).toBe(200);
    resetBcpCacheForTests();
    const board = (await (await handleRequest(get("/api/board"), e, opts())).json()) as WdcBoardState;
    expect(board.coach).toEqual(doc());
    expect(board.rounds[0].tables.find((t) => t.us === "Steve Trimble")).toMatchObject({
      coachScore: 9,
      nudge: 2,
    });
  });
});

describe("other paths", () => {
  it("answers 404 JSON for an unknown /api path, never the board page", async () => {
    const { env: e, assets } = env();
    for (const path of ["/api", "/api/", "/api/nope", "/api/board/extra", "/api/admin/wdc/pin"]) {
      const res = await handleRequest(get(path), e, opts());
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toMatchObject({ ok: false, reason: "not-found" });
      expectSecurityHeaders(res);
    }
    expect(assets.seen).toEqual([]);
  });

  it("serves the board page at / from the assets, with the security headers", async () => {
    const { env: e } = env();
    const res = await handleRequest(get("/"), e, opts());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX);
    expectSecurityHeaders(res);
  });

  it("caches a hashed /assets/ file for a year, immutable", async () => {
    const { env: e } = env();
    const res = await handleRequest(get("/assets/index-abc123.js"), e, opts());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("content-type")).toBe("text/javascript");
    expect(await res.text()).toBe("console.log(1)");
    expectSecurityHeaders(res);
  });

  it("keeps the page itself revalidating: /, /index.html and a page route are never immutable", async () => {
    const { env: e } = env();
    for (const path of ["/", "/index.html", "/round/3"]) {
      const res = await handleRequest(get(path), e, opts());
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control"), path).toBe(ASSET_LAYER_CACHE);
    }
  });

  it("never marks the single-page fallback immutable when it answers an /assets/ path", async () => {
    const { env: e } = env();
    // the real asset layer answers a missing /assets/ file with index.html and 200
    e.ASSETS = {
      fetch: async () =>
        new Response(INDEX, {
          headers: { "content-type": "text/html", "cache-control": ASSET_LAYER_CACHE },
        }),
    };
    const res = await handleRequest(get("/assets/index-old.js"), e, opts());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(ASSET_LAYER_CACHE);
  });

  it("keeps /api answers no-store", async () => {
    const { env: e } = env();
    for (const path of ["/api/board", "/api/nope"]) {
      const res = await handleRequest(get(path), e, opts());
      expect(res.headers.get("cache-control"), path).toBe("no-store");
    }
  });

  it("falls back to the board page for a page route the assets do not have (SPA)", async () => {
    const { env: e, assets } = env();
    const res = await handleRequest(get("/round/3"), e, opts());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX);
    expect(assets.seen).toEqual(["/round/3", "/"]);
    expectSecurityHeaders(res);
  });

  it("keeps a 404 for a missing file (a path with an extension)", async () => {
    const { env: e } = env();
    const res = await handleRequest(get("/assets/missing.js"), e, opts());
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBeNull();
    expectSecurityHeaders(res);
  });

  it("turns a thrown error into a 500 envelope that still carries the headers", async () => {
    const { env: e } = env();
    e.ASSETS = {
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const res = await handleRequest(get("/"), e, opts());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, reason: "unavailable" });
    expectSecurityHeaders(res);
  });

  it("exports a module Worker whose fetch is the same handler", async () => {
    const { env: e } = env();
    const res = await worker.fetch(get("/api/nope"), e);
    expect(res.status).toBe(404);
    expectSecurityHeaders(res);
  });
});

describe("security headers", () => {
  it("allow this origin, inline styles and Bunny Fonts, and nothing inline for scripts", () => {
    const csp = Object.fromEntries(
      CONTENT_SECURITY_POLICY.split("; ").map((d) => {
        const [name, ...values] = d.split(" ");
        return [name, values];
      }),
    );
    expect(csp["default-src"]).toEqual(["'self'"]);
    expect(csp["script-src"]).toEqual(["'self'"]);
    expect(csp["style-src"]).toEqual(["'self'", "'unsafe-inline'", "https://fonts.bunny.net"]);
    expect(csp["font-src"]).toContain("https://fonts.bunny.net");
    expect(csp["connect-src"]).toEqual(["'self'"]);
    expect(csp["frame-ancestors"]).toEqual(["'none'"]);
    expect(csp["object-src"]).toEqual(["'none'"]);
    expect(CONTENT_SECURITY_POLICY).not.toContain("googleapis");
    expect(CONTENT_SECURITY_POLICY).not.toContain("bestcoastpairings");
  });
});
