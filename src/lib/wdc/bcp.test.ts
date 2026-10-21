// @vitest-environment node
//
// BCP client for the coach board (docs/CONTRACT.md C2). The fixtures are real, unedited
// responses for TEO-8 "All in." (event JkPs5aELBHPh), saved 2026-10-16 from the public API:
// event, team standings, round 1 player pairings and round 1 team pairings.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import eventFixture from "./fixtures/event.json";
import standingsFixture from "./fixtures/standings.json";
import round1PairingFixture from "./fixtures/round1-pairing.json";
import round1TeamPairingFixture from "./fixtures/round1-teampairing.json";
// Live round 2 (both pairing types), saved 2026-10-17 04:16 UTC with a plain unauthenticated GET.
import round2PairingFixture from "./fixtures/round2-pairing.json";
import round2TeamPairingFixture from "./fixtures/round2-teampairing.json";
import {
  BcpError,
  bcpTeamKey,
  fetchBcpRound,
  fetchBcpStandings,
  loadBcpSnapshot,
  resetBcpCacheForTests,
  type BcpFetch,
} from "./bcp.server";

const EVENT = "JkPs5aELBHPh";
const OUR = "Warp Dust Crusaders";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Serves the fixtures; every round after 1 is unpaired (200, empty lists), like BCP. */
const fixtureFetch = (): ReturnType<typeof vi.fn<BcpFetch>> =>
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

beforeEach(() => {
  resetBcpCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("loadBcpSnapshot (TEO-8 fixtures)", () => {
  it("reads the event and all 17 teams", async () => {
    const snap = await loadBcpSnapshot(EVENT, OUR, fixtureFetch());
    expect(snap.event).toEqual({
      id: EVENT,
      name: "TEO-8 - All in.",
      where: "Hopkinsville, KY",
      rounds: 5,
      teamSize: 8,
    });
    expect(Object.keys(snap.teams)).toHaveLength(17);
    expect(snap.teams["Mandatory F.U.N."]).toBeDefined();
    expect(snap.teams[OUR]?.placing).toBe(1);
    expect(snap.teams[OUR]?.captain).toBe("Hogan Franklin");
    expect(Date.parse(snap.bcpAt)).not.toBeNaN();
  });

  it("gives every team its eight players, at the 1400 unknown-Elo fallback", async () => {
    const snap = await loadBcpSnapshot(EVENT, OUR, fixtureFetch());
    const sizes = Object.values(snap.teams).map((t) => t.players.length);
    // The bye team's own round 1 games are real rows too; every team fields 8.
    expect(sizes.every((s) => s === 8)).toBe(true);
    for (const p of Object.values(snap.teams).flatMap((t) => t.players)) {
      expect(p.elo).toBe(1400);
      expect(p.eloKnown).toBe(false);
    }
  });

  it("fills Warp Dust Crusaders with 8 players that all have faction, dispo and a list id", async () => {
    const snap = await loadBcpSnapshot(EVENT, OUR, fixtureFetch());
    const team = snap.teams[OUR];
    expect(team?.players).toHaveLength(8);
    for (const p of team?.players ?? []) {
      expect(p.team).toBe(OUR);
      expect(p.faction).not.toBe("");
      expect(p.dispo).not.toBe("");
      expect(p.list).toBeTruthy();
    }
    const ethan = team?.players.find((p) => p.name === "Ethan Davis");
    expect(ethan).toMatchObject({
      faction: "World Eaters",
      dispo: "Purge the Foe",
      list: "HxdkMG5P5SE8",
    });
  });

  it("merges standings metrics into the team", async () => {
    const snap = await loadBcpSnapshot(EVENT, OUR, fixtureFetch());
    const wdc = snap.teams[OUR];
    expect(wdc?.matchPoints).toBe(4);
    expect(wdc?.battlePoints).toBe(297);
    expect(wdc?.gameWins).toBe(16);
  });

  it("builds round 1: opponent Mandatory F.U.N., our 8 tables in table order, Dustin Hammond scored 18", async () => {
    const snap = await loadBcpSnapshot(EVENT, OUR, fixtureFetch());
    expect(snap.rounds).toHaveLength(1);
    const r1 = snap.rounds[0];
    expect(r1).toMatchObject({ n: 1, opp: "Mandatory F.U.N.", fromBcp: true });
    expect(r1?.tables).toHaveLength(8);
    expect(r1?.tables.map((t) => t.t)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const dustin = r1?.tables.find((t) => t.us === "Dustin Hammond");
    expect(dustin).toMatchObject({
      t: 8,
      them: "William Nix",
      bcpScore: 18,
      coachScore: null,
      nudge: 0,
    });
    // Table 3: our player registered under "Art of War", yet the match places him on our side.
    expect(r1?.tables.find((t) => t.t === 3)).toMatchObject({
      us: "Bryce Bennett",
      them: "Darrion DuBay",
    });
    expect(snap.played).toEqual(["Mandatory F.U.N."]);
    // The opponent's side of the same eight games is on their roster.
    const them = snap.teams["Mandatory F.U.N."]?.players.map((p) => p.name) ?? [];
    expect(them).toContain("William Nix");
  });
});

describe("fetchBcpRound", () => {
  it("skips bye placeholders and reads both pairing types", async () => {
    const round = await fetchBcpRound(EVENT, 1, fixtureFetch());
    expect(round.pairings).toHaveLength(72);
    expect(round.pairings.filter((p) => p.p1 === null || p.p2 === null)).toHaveLength(8);
    expect(round.teamPairings).toHaveLength(9);
    const bye = round.teamPairings.find((t) => t.teamB === null);
    expect(bye?.teamA).toBe("Melta Mafia Beta");
  });

  it("treats a dash-filled placeholder seat as a bye", async () => {
    const rows = {
      active: [
        {
          table: 1,
          published: true,
          isDone: false,
          teamPairingId: "x",
          player1: {
            user: { firstName: "A", lastName: "B" },
            faction: "Orks",
            subFaction: "d",
            listId: "l",
          },
          player2: { user: { firstName: "--------", lastName: "" } },
        },
      ],
    };
    const f = vi.fn<BcpFetch>(async () => json(rows));
    const round = await fetchBcpRound("E", 1, f);
    expect(round.pairings[0]?.p2).toBeNull();
    expect(round.pairings[0]?.p1?.name).toBe("A B");
  });
});

describe("team name keys", () => {
  it("ignores case, spacing and trailing punctuation", () => {
    expect(bcpTeamKey("Mandatory F.U.N")).toBe(bcpTeamKey("Mandatory F.U.N."));
    expect(bcpTeamKey("The ScallyWaaghs ")).toBe(bcpTeamKey("The Scallywaaghs"));
  });
});

describe("errors", () => {
  it("rejects a 500 with BcpError carrying url and status", async () => {
    const f = vi.fn<BcpFetch>(async () => json({ error: "boom" }, 500));
    const err = await loadBcpSnapshot(EVENT, OUR, f).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BcpError);
    expect((err as BcpError).name).toBe("BcpError");
    expect((err as BcpError).status).toBe(500);
    expect((err as BcpError).url).toContain(`/events/${EVENT}`);
  });

  it("rejects when a later round fails instead of resolving a partial snapshot", async () => {
    const ok = fixtureFetch();
    const f = vi.fn<BcpFetch>(async (url, init) => {
      if (new URL(url).searchParams.get("round") === "2") return json({}, 503);
      return ok(url, init);
    });
    const snap = await loadBcpSnapshot(EVENT, OUR, f).catch((e: unknown) => e);
    // Round 2 is only requested if round 1 was published; it was, so the failure must surface.
    expect(snap).toBeInstanceOf(BcpError);
    expect((snap as BcpError).status).toBe(503);
  });

  it("rejects network errors with status 0", async () => {
    const f = vi.fn<BcpFetch>(async () => {
      throw new TypeError("fetch failed");
    });
    const err = await fetchBcpStandings(EVENT, f).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BcpError);
    expect((err as BcpError).status).toBe(0);
  });

  it("rejects bad JSON and a body without active[]", async () => {
    const bad = vi.fn<BcpFetch>(async () => new Response("<html>nope</html>", { status: 200 }));
    await expect(fetchBcpStandings(EVENT, bad)).rejects.toBeInstanceOf(BcpError);
    resetBcpCacheForTests();
    const shapeless = vi.fn<BcpFetch>(async () => json({ hello: "world" }));
    await expect(fetchBcpStandings(EVENT, shapeless)).rejects.toBeInstanceOf(BcpError);
  });

  it("does not cache a failure", async () => {
    let fail = true;
    const f = vi.fn<BcpFetch>(async () => (fail ? json({}, 500) : json(standingsFixture)));
    await expect(fetchBcpStandings(EVENT, f)).rejects.toBeInstanceOf(BcpError);
    fail = false;
    await expect(fetchBcpStandings(EVENT, f)).resolves.toHaveLength(17);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("60 second cache", () => {
  it("serves the second call within 60 s from memory, and sends the client-id header", async () => {
    const f = fixtureFetch();
    await fetchBcpStandings(EVENT, f);
    expect(f).toHaveBeenCalledTimes(1);
    const init = f.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)["client-id"]).toBe("web-app");
    await fetchBcpStandings(EVENT, f);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a whole snapshot loaded twice hits BCP once per URL", async () => {
    const f = fixtureFetch();
    await loadBcpSnapshot(EVENT, OUR, f);
    const calls = f.mock.calls.length;
    await loadBcpSnapshot(EVENT, OUR, f);
    expect(f.mock.calls.length).toBe(calls);
  });

  it("refetches after 60 s", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T20:00:00Z"));
    const f = fixtureFetch();
    await fetchBcpStandings(EVENT, f);
    vi.setSystemTime(new Date("2026-10-16T20:00:59Z"));
    await fetchBcpStandings(EVENT, f);
    expect(f).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-10-16T20:01:01Z"));
    await fetchBcpStandings(EVENT, f);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("resetBcpCacheForTests clears it", async () => {
    const f = fixtureFetch();
    await fetchBcpStandings(EVENT, f);
    resetBcpCacheForTests();
    await fetchBcpStandings(EVENT, f);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

// --- t-732: timeout (D3), team pairing before the player rows (D5), rows without a table (D6) ---

type Rows = { active: Array<Record<string, unknown>> };
const clone = (fixture: unknown): Rows => structuredClone(fixture) as Rows;

/** Like fixtureFetch, but serves whatever each round is given; unlisted rounds are unpaired. */
const roundsFetch = (
  byRound: Record<number, { team: unknown; pair: unknown }>,
): ReturnType<typeof vi.fn<BcpFetch>> =>
  vi.fn<BcpFetch>(async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/teamPlayers")) return json(standingsFixture);
    if (u.pathname.endsWith("/pairings")) {
      const r = byRound[Number(u.searchParams.get("round"))];
      if (!r) return json({ active: [], deleted: [] });
      return json(u.searchParams.get("pairingType") === "TeamPairing" ? r.team : r.pair);
    }
    return json(eventFixture);
  });

const R1 = { team: round1TeamPairingFixture, pair: round1PairingFixture };
const OUR_R1_MATCH = "eRwYAReeD62v";
const OUR_R2_MATCH = "cIqaHFPfFIKW";

const hang = (): ReturnType<typeof vi.fn<BcpFetch>> =>
  vi.fn<BcpFetch>(() => new Promise<Response>(() => {}));

describe("8 second deadline", () => {
  it("a fetch that never resolves rejects with BcpError timeout after 8 s, and the next call fetches again", async () => {
    vi.useFakeTimers();
    const f = hang();
    let settled = false;
    const first = fetchBcpStandings(EVENT, f)
      .catch((e: unknown) => e)
      .finally(() => {
        settled = true;
      });
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = await first;
    expect(err).toBeInstanceOf(BcpError);
    expect((err as BcpError).kind).toBe("timeout");
    expect((err as BcpError).status).toBe(0);
    expect((err as BcpError).url).toContain("/teamPlayers");

    // The rejected entry left the cache: well inside 60 s, the next call is a new request.
    const second = fetchBcpStandings(EVENT, f).catch((e: unknown) => e);
    expect(f).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(((await second) as BcpError).kind).toBe("timeout");
  });

  it("concurrent callers during the hang share one fetch, then all reject", async () => {
    vi.useFakeTimers();
    const f = hang();
    const calls = [1, 2, 3].map(() => fetchBcpStandings(EVENT, f).catch((e: unknown) => e));
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(8_000);
    const errs = await Promise.all(calls);
    for (const e of errs) {
      expect(e).toBeInstanceOf(BcpError);
      expect((e as BcpError).kind).toBe("timeout");
    }
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("passes an abort signal to fetch so the runtime can cancel the request", async () => {
    const f = fixtureFetch();
    await fetchBcpStandings(EVENT, f);
    expect(f.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("still times out when the runtime has no AbortSignal.timeout", async () => {
    vi.useFakeTimers();
    const original = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
    Object.defineProperty(AbortSignal, "timeout", { value: undefined, configurable: true });
    try {
      const f = hang();
      const p = fetchBcpStandings(EVENT, f).catch((e: unknown) => e);
      expect(f.mock.calls[0]?.[1]?.signal).toBeUndefined();
      await vi.advanceTimersByTimeAsync(8_000);
      expect(((await p) as BcpError).kind).toBe("timeout");
    } finally {
      if (original) Object.defineProperty(AbortSignal, "timeout", original);
    }
  });

  it("maps a fetch aborted by its signal to kind timeout, other failures to network and status", async () => {
    const aborted = vi.fn<BcpFetch>(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const e1 = await fetchBcpStandings(EVENT, aborted).catch((e: unknown) => e);
    expect((e1 as BcpError).kind).toBe("timeout");
    const down = vi.fn<BcpFetch>(async () => {
      throw new TypeError("fetch failed");
    });
    const e2 = await fetchBcpStandings(EVENT, down).catch((e: unknown) => e);
    expect((e2 as BcpError).kind).toBe("network");
    const bad = vi.fn<BcpFetch>(async () => json({}, 502));
    const e3 = await fetchBcpStandings(EVENT, bad).catch((e: unknown) => e);
    expect((e3 as BcpError).kind).toBe("status");
  });

  it("keeps the 60 s success cache", async () => {
    vi.useFakeTimers();
    const f = fixtureFetch();
    await fetchBcpStandings(EVENT, f);
    await vi.advanceTimersByTimeAsync(30_000);
    await fetchBcpStandings(EVENT, f);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("team pairing posted before the player rows", () => {
  it("round 2 with the team pairing up and {active: []} player rows is not emitted", async () => {
    const f = roundsFetch({ 1: R1, 2: { team: round2TeamPairingFixture, pair: { active: [] } } });
    const round = await fetchBcpRound(EVENT, 2, f);
    expect(round.teamPairings).toHaveLength(9);
    expect(round.pairings).toHaveLength(0);
    const snap = await loadBcpSnapshot(EVENT, OUR, f);
    expect(snap.rounds.map((r) => r.n)).toEqual([1]);
    expect(snap.played).toEqual(["Mandatory F.U.N."]);
    expect(snap.rounds.every((r) => r.tables.length > 0)).toBe(true);
  });

  it("round 2 is not emitted while other matches have player rows and ours has none", async () => {
    const pair = clone(round2PairingFixture);
    pair.active = pair.active.filter((r) => r.teamPairingId !== OUR_R2_MATCH);
    const f = roundsFetch({ 1: R1, 2: { team: round2TeamPairingFixture, pair } });
    const snap = await loadBcpSnapshot(EVENT, OUR, f);
    expect(snap.rounds.map((r) => r.n)).toEqual([1]);
    expect(snap.played).toEqual(["Mandatory F.U.N."]);
  });

  it("round 2 is emitted once our eight player rows are posted (live round 2)", async () => {
    const f = roundsFetch({
      1: R1,
      2: { team: round2TeamPairingFixture, pair: round2PairingFixture },
    });
    const snap = await loadBcpSnapshot(EVENT, OUR, f);
    expect(snap.rounds.map((r) => r.n)).toEqual([1, 2]);
    const r2 = snap.rounds[1];
    expect(r2?.opp).toMatch(/^Rule Lawyerz/);
    expect(r2?.tables.map((t) => t.t)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r2?.tables.find((t) => t.us === "Dustin Hammond")).toMatchObject({
      t: 3,
      them: "Jared Street",
      bcpScore: 16,
    });
    expect(snap.played).toEqual(["Mandatory F.U.N.", r2?.opp]);
    expect(snap.warnings).toEqual([]);
  });
});

describe("pairing rows without a table number", () => {
  const brokenRound1 = (): Rows => {
    const pair = clone(round1PairingFixture);
    const ours = pair.active.filter((r) => r.teamPairingId === OUR_R1_MATCH);
    // Our table 8 (Dustin Hammond) loses its table; our table 7 gets table 0.
    const t8 = ours.find((r) => r.table === 8);
    const t7 = ours.find((r) => r.table === 7);
    if (!t8 || !t7) throw new Error("fixture changed");
    delete t8.table;
    t7.table = 0;
    // A seatless row without a table loses nothing and is not counted.
    pair.active.push({ published: true, isDone: false, teamPairingId: OUR_R1_MATCH });
    return pair;
  };

  it("fetchBcpRound drops them, counts them, and never yields table 0", async () => {
    const f = roundsFetch({ 1: { team: round1TeamPairingFixture, pair: brokenRound1() } });
    const round = await fetchBcpRound(EVENT, 1, f);
    expect(round.dropped).toBe(2);
    expect(round.pairings).toHaveLength(70);
    expect(round.pairings.every((p) => Number.isInteger(p.table) && p.table >= 1)).toBe(true);
  });

  it("the snapshot's tables never carry t 0 and the drop is reported", async () => {
    const f = roundsFetch({ 1: { team: round1TeamPairingFixture, pair: brokenRound1() } });
    const snap = await loadBcpSnapshot(EVENT, OUR, f);
    expect(snap.rounds[0]?.tables.map((t) => t.t)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(snap.rounds.flatMap((r) => r.tables).some((t) => t.t === 0)).toBe(false);
    expect(snap.warnings).toEqual(["Round 1: 2 BCP games without a table number skipped"]);
  });

  it("the recorded fixtures drop nothing", async () => {
    const round = await fetchBcpRound(EVENT, 1, fixtureFetch());
    expect(round.dropped).toBe(0);
    const snap = await loadBcpSnapshot(EVENT, OUR, fixtureFetch());
    expect(snap.warnings).toEqual([]);
  });
});
