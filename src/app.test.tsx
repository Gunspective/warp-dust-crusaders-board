import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The repo ships matchup-snapshot.json empty; the page tests run on the synthetic fixture instead.
vi.mock("./lib/wdc/matchup-snapshot.json", () => import("./lib/wdc/fixtures/matchups-sample.json"));
import { makeBoard, makeHistory, makeLockBoard, OUR } from "./components/wdc/fixture";
import {
  applyCoach,
  FACTION_MARK_POINTS,
  MATCHUPS,
  matchupLabel,
  pairForecast,
} from "./components/wdc/model";
import { DEFAULT_WEIGHTS, type PlayerHistorySnapshot } from "./lib/wdc/history";
import type { WdcBoardState } from "./lib/wdc/types";

// Board render tests (contract C1, C4, C6, C7). The page is <App/> (src/app.tsx): it loads the first
// board through getWdcBoard and hands it to <WdcBoard/>, which these tests mostly render directly
// with a fixture board. The API client is mocked at its module: the page only needs results.

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
  // The board's player-history snapshot: empty unless a test fills it, so the real snapshot never
  // moves these fixtures' forecasts.
  history: {
    generatedAt: "",
    eventId: "",
    windowStart: "",
    editionStart: "",
    players: {},
  } as PlayerHistorySnapshot,
}));

vi.mock("./components/wdc/history-data", () => ({
  HISTORY: mocks.history,
  asHistorySnapshot: (v: unknown) => v,
}));
vi.mock("./lib/api/wdc.functions", () => ({
  getWdcBoard: (...args: unknown[]) => mocks.get(...args),
  saveWdcCoachState: (...args: unknown[]) => mocks.save(...args),
}));

const { WdcBoard } = await import("./components/wdc/wdc-board");
const { App } = await import("./app");

const ROOT = join(__dirname, "..");

function load(board: WdcBoardState) {
  mocks.get.mockResolvedValue(board);
  return render(<WdcBoard initial={board} />);
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.save.mockReset();
  mocks.history.players = {};
  try {
    window.localStorage.clear();
  } catch {
    // no storage in this environment
  }
});

afterEach(() => {
  cleanup();
});

// The server accepts every save and echoes the board with the coach document merged; the poll that
// follows a save then reads the same board, as the real merged state would.
function acceptSaves() {
  mocks.save.mockImplementation(async ({ data }: { data: { coach: WdcBoardState["coach"] } }) => {
    const state = makeBoard({ coach: data.coach });
    mocks.get.mockResolvedValue(state);
    return { ok: true, state };
  });
}

const tap = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};

describe("board board view", () => {
  it("renders 8 table cards with Elo, faction, dispo and both list links", () => {
    load(makeBoard());
    const cards = screen.getAllByRole("article");
    expect(cards).toHaveLength(8);
    const first = within(cards[0]);
    expect(first.getByText("Us Player 1")).toBeTruthy();
    expect(first.getByText("NearA Player 1")).toBeTruthy();
    // Elo, faction and disposition for both sides.
    expect(first.getByText("1500")).toBeTruthy();
    expect(first.getByText("1480")).toBeTruthy();
    expect(first.getAllByText("World Eaters")).toHaveLength(2);
    expect(first.getAllByText("Purge the Foe")).toHaveLength(2);
    const their = first.getByRole("link", { name: /Their list/ });
    expect(their.getAttribute("href")).toBe("https://www.bestcoastpairings.com/list/nearalist1");
    expect(their.getAttribute("target")).toBe("_blank");
    expect(first.getByRole("link", { name: /Our list/ }).getAttribute("href")).toBe(
      "https://www.bestcoastpairings.com/list/uslist1",
    );
    expect(screen.getAllByRole("link", { name: /Their list/ })).toHaveLength(8);
    expect(screen.getAllByRole("link", { name: /Our list/ })).toHaveLength(8);
  });

  it("shows an unrated player's Elo in grey, not bold", () => {
    load(makeBoard());
    const card8 = screen.getAllByRole("article")[7];
    const elos = card8.querySelectorAll(".elo");
    // Player 8 on both sides is the fixture's unknown-Elo seat.
    expect(elos[0].className).toContain("unk");
    expect(elos[1].className).toContain("unk");
    expect(screen.getAllByRole("article")[0].querySelector(".elo")?.className).not.toContain("unk");
  });

  it("reads Match won and 109 locked with six scored tables and two open", () => {
    const board = makeBoard();
    const scores = [18, 17, 19, 20, 18, 17]; // 109, two of them posted by BCP and four by the coach
    board.rounds[0].tables.forEach((t, i) => {
      if (i < 6) {
        if (i < 2) t.bcpScore = scores[i];
        else t.coachScore = scores[i];
      }
    });
    load(board);
    expect(screen.getByText("Match won")).toBeTruthy();
    expect(screen.getByText(/109 locked with 2 tables to play/)).toBeTruthy();
    expect(screen.getByText("6 of 8 tables done")).toBeTruthy();
    // A BCP-posted table cannot be re-scored by the coach.
    expect(
      (screen.getByRole("button", { name: /Table 1 posted on BCP: 18 to 2/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("shows the need line while the match is open", () => {
    load(makeBoard());
    expect(screen.getByText(/To win:/).textContent).toMatch(
      /To win: 81 more from 8 tables \(10\.1 per game\)/,
    );
    expect(screen.getByText(/To draw:/).textContent).toBe("To draw: 80");
    expect(screen.getByText("Line").parentElement?.textContent).toContain("81");
  });

  it("enables round chips only for rounds present", () => {
    load(makeBoard());
    const chips = screen.getAllByRole("button", { name: /^R\d$/ }) as HTMLButtonElement[];
    expect(chips).toHaveLength(5);
    expect(chips.map((c) => c.disabled)).toEqual([false, true, true, true, true]);
  });

  it("shows a quiet unreachable line only when BCP is stale", () => {
    const { unmount } = load(makeBoard());
    expect(screen.queryByText(/BCP unreachable/)).toBeNull();
    unmount();
    load(makeBoard({ stale: true }));
    expect(screen.getByText(/BCP unreachable since \d\d:\d\d/)).toBeTruthy();
  });

  it("keeps two-line names off the tablet cards: one line with an ellipsis, the full name in its title (t-742)", () => {
    // TEO-8 round 5: these names wrapped to two lines at 1024x768 and pushed the forecast row's 44px
    // buttons 15px past the card (jsdom cannot measure layout, so this pins the rule that prevents it)
    const LONG: Record<string, string> = {
      "Us Player 4": "Nicholas Fromme",
      "Us Player 6": "Dustin Hammond",
      "NearA Player 8": "Justin Mooneyham",
    };
    const rename = (n: string) => LONG[n] ?? n;
    const base = makeBoard();
    const teams = Object.fromEntries(
      Object.entries(base.teams).map(([k, t]) => [
        k,
        { ...t, players: t.players.map((p) => ({ ...p, name: rename(p.name) })) },
      ]),
    );
    const rounds = base.rounds.map((r) => ({
      ...r,
      tables: r.tables.map((tb) => ({ ...tb, us: rename(tb.us), them: rename(tb.them) })),
    }));
    const { container } = load({ ...base, teams, rounds });
    const cards = screen.getAllByRole("article");
    for (const [t, name] of [
      [4, "Nicholas Fromme"],
      [6, "Dustin Hammond"],
      [8, "Justin Mooneyham"],
    ] as const) {
      const who = within(cards[t - 1]).getByText(name);
      expect(who.className).toBe("who");
      expect(who.getAttribute("title")).toBe(name);
    }
    // every name on every card carries its full text as a title
    const whos = [...container.querySelectorAll<HTMLElement>(".card .who")];
    expect(whos).toHaveLength(16);
    for (const w of whos) expect(w.getAttribute("title")).toBe(w.textContent);

    const css = container.querySelector("style")?.textContent ?? "";
    const at = css.indexOf("@media (min-width:900px) and (orientation:landscape)");
    const tablet = css.slice(at, css.indexOf("@media (prefers-reduced-motion", at));
    // tablet: a name is one line, so the card's rows cannot grow past the 1fr grid row
    expect(tablet).toMatch(
      /\.wdc \.side \.who\{[^}]*white-space:nowrap;overflow:hidden;text-overflow:ellipsis;overflow-wrap:normal/,
    );
    expect(tablet).toMatch(/\.wdc \.card\{min-height:0;overflow:hidden;[^}]*grid-template-rows:auto 1fr 1fr auto/);
    // the forecast row's controls keep their 44px
    expect(tablet).toMatch(/\.wdc \.listlink\{min-height:44px/);
    expect(tablet).toMatch(/\.wdc \.nudge button\{min-width:44px;min-height:44px/);
    // phone (no media query): the column scrolls, so a long name still wraps in full there
    expect(css.slice(0, at)).toMatch(/\.wdc \.side \.who\{[^}]*overflow-wrap:anywhere/);
    expect(css.slice(0, at)).not.toMatch(/\.wdc \.side \.who\{[^}]*white-space:nowrap/);
  });

  it("ends the footer's Elo source sentence with one full stop, never two", () => {
    const source =
      "Elo from the Stat Check table snapshot generated 2026-10-17: pulled by headless Playwright and downloading the file.";
    const { container, unmount } = load(makeBoard({ eloSource: source }));
    const foot = container.querySelector(".readonly")?.textContent ?? "";
    expect(foot).toContain("downloading the file. Grey Elo means");
    expect(foot).not.toContain("..");
    unmount();
    const plain = load(makeBoard({ eloSource: "Stat Check snapshot" }));
    expect(plain.container.querySelector(".readonly")?.textContent).toContain(
      "Elo: Stat Check snapshot. Grey Elo means",
    );
    plain.unmount();
    const none = load(makeBoard({ eloSource: "" }));
    expect(none.container.querySelector(".readonly")?.textContent).toContain("Elo: unknown. Grey Elo");
  });
});

describe("board pairing view", () => {
  const openPairing = async () => {
    await tap(screen.getByRole("tab", { name: "Pairing" }));
  };
  const optionNames = () =>
    Array.from((screen.getByLabelText("Opponent") as HTMLSelectElement).options)
      .map((o) => o.textContent ?? "")
      .filter((t) => !t.startsWith("Choose"));

  it("lists only teams within one match result (2 MP), minus played teams and ourselves, and Show all reveals the rest", async () => {
    load(makeBoard({ played: ["Played Team"] }));
    await openPairing();
    const names = optionNames();
    // Our match points are 2: Near A (2), Near B (3), Near C (1), Far Low (0). Played Team is excluded as played,
    // Far High (5) is three away, and we never list ourselves.
    expect(names).toEqual([
      "1. Near A (2 MP)",
      "5. Near B (3 MP)",
      "6. Near C (1 MP)",
      "16. Far Low (0 MP)",
    ]);
    expect(names.join("|")).not.toContain(OUR);

    await tap(screen.getByRole("button", { name: "Show all" }));
    const all = optionNames();
    expect(all).toEqual([
      "1. Near A (2 MP)",
      "2. Played Team (2 MP) - played",
      "3. Far High (5 MP)",
      "5. Near B (3 MP)",
      "6. Near C (1 MP)",
      "16. Far Low (0 MP)",
    ]);
  });

  it("locks a pairing in order, unlocks on a second tap, and arms Set tables only at eight locks", async () => {
    acceptSaves();
    window.localStorage.setItem("wdc.pin", "1234");
    load(
      makeBoard({ coach: { rounds: {}, pairing: { opp: "Near A", locks: [] }, eloOverrides: {} } }),
    );
    await openPairing();
    expect(screen.getAllByRole("button", { name: /Us Player \d vs NearA Player \d/ })).toHaveLength(
      64,
    );
    const cell = (u: number, t: number) =>
      screen.getByRole("button", { name: new RegExp(`^Us Player ${u} vs NearA Player ${t},`) });
    const setBtn = () =>
      screen.getByRole("button", { name: /Set tables for round 2/ }) as HTMLButtonElement;

    await tap(cell(1, 1));
    expect(cell(1, 1).className).toContain("lock");
    expect(cell(1, 1).textContent).toContain("table 1");
    expect(cell(1, 2).className).toContain("dim"); // locked row dims the rest of that row
    await tap(cell(1, 1));
    expect(cell(1, 1).className).not.toContain("lock");

    expect(setBtn().disabled).toBe(true);
    for (let i = 1; i <= 8; i++) await tap(cell(i, i));
    expect(setBtn().disabled).toBe(false);
    const last = mocks.save.mock.calls.at(-1)![0].data.coach.pairing;
    expect(last.opp).toBe("Near A");
    expect(last.locks).toHaveLength(8);
    expect(last.locks[2]).toEqual({ us: "Us Player 3", them: "NearA Player 3" });

    await tap(setBtn());
    // Back on the board after setting, as the prototype does.
    expect(screen.getByRole("tab", { name: "Board" }).getAttribute("aria-selected")).toBe("true");
  });

  it("marks cells good at 12+, bad at 8 or less, and outlines each player's best remaining matchup", async () => {
    // Lopsided Elo so both colours appear.
    const board = makeBoard({
      coach: { rounds: {}, pairing: { opp: "Far High", locks: [] }, eloOverrides: {} },
    });
    load(board);
    await openPairing();
    const cells = screen.getAllByRole("button", { name: /^Us Player \d vs FarHigh Player \d,/ });
    expect(cells).toHaveLength(64);
    expect(cells.some((c) => c.className.includes("bad"))).toBe(true);
    expect(cells.filter((c) => c.className.includes("best"))).toHaveLength(8);
    expect(screen.getAllByText("their worst").length).toBeGreaterThan(0);
  });

  it("shifts a cell by the Stat Check faction matchup and marks it with its matchup label", async () => {
    // The real snapshot's most lopsided matchup at even Elo, so the test follows a refreshed snapshot.
    const flat = { elo: 1500, eloKnown: true, team: "", dispo: "", list: null };
    let pick: { us: string; them: string; shift: number } | null = null;
    for (const [us, opps] of Object.entries(MATCHUPS.rows)) {
      for (const them of Object.keys(opps)) {
        const f = pairForecast(
          { ...flat, name: "a", faction: us },
          { ...flat, name: "b", faction: them },
        );
        const shift = f.points - f.eloOnly;
        if (!pick || shift > pick.shift) pick = { us, them, shift };
      }
    }
    expect(pick!.shift).toBeGreaterThanOrEqual(FACTION_MARK_POINTS);
    const board = makeBoard({
      coach: { rounds: {}, pairing: { opp: "Near A", locks: [] }, eloOverrides: {} },
    });
    const usP = board.teams[OUR].players[0];
    const themP = board.teams["Near A"].players[0];
    usP.faction = pick!.us;
    themP.faction = pick!.them;
    const f = pairForecast(usP, themP);
    expect(f.points - f.eloOnly).toBeGreaterThanOrEqual(FACTION_MARK_POINTS);
    const label = matchupLabel(f.matchup!);
    expect(label).toMatch(/^Faction matchup: .+ \d+% vs .+ over \d+ games?$/);
    load(board);

    // Board card for table 1 (that same pair) already shows the faction-shifted forecast.
    const card = screen.getAllByRole("article")[0];
    expect(within(card).getByText(/^Forecast/).textContent).toContain(
      `${f.points}-${20 - f.points}`,
    );
    expect(screen.getByText(/Forecasts also use Stat Check faction matchups \(/)).toBeTruthy();

    await openPairing();
    const cell = screen.getByRole("button", { name: /^Us Player 1 vs NearA Player 1,/ });
    expect(cell.getAttribute("aria-label")).toBe(
      `Us Player 1 vs NearA Player 1, forecast ${f.points} to ${20 - f.points}, ${label}`,
    );
    const mark = cell.querySelector(".fx");
    expect(mark?.textContent).toBe("F");
    expect(mark?.getAttribute("title")).toBe(label);
    // A mirror pair (Us Player 2 and NearA Player 2 share a faction) carries no marker.
    const mirror = screen.getByRole("button", { name: /^Us Player 2 vs NearA Player 2,/ });
    expect(mirror.querySelector(".fx")).toBeNull();
    expect(mirror.getAttribute("aria-label")).not.toContain("Faction matchup");
    expect(screen.getByText(/F: faction moved it 2\+\)/)).toBeTruthy();
  });
});

describe("board score pad", () => {
  const openPad = async (table = 3) => {
    await tap(screen.getByRole("button", { name: new RegExp(`score for table ${table}$`) }));
    return screen.getByRole("dialog");
  };

  it("opens 21 keys on tap and saves our points with one tap on 18", async () => {
    acceptSaves();
    window.localStorage.setItem("wdc.pin", "4321");
    load(makeBoard());
    const pad = await openPad(3);
    const keys = within(pad).getAllByRole("button", { name: /^\d+$/ });
    expect(keys).toHaveLength(21);
    expect(keys.map((k) => k.textContent)).toEqual(Array.from({ length: 21 }, (_, n) => String(n)));
    // The forecast key is outlined.
    expect(keys.filter((k) => k.className.includes("fc"))).toHaveLength(1);

    await tap(within(pad).getByRole("button", { name: "18" }));
    expect(mocks.save).toHaveBeenCalledTimes(1);
    const arg = mocks.save.mock.calls[0][0];
    expect(arg.data.pin).toBe("4321");
    expect(arg.data.coach.rounds["1"].players["us player 3"].score).toBe(18);
    expect(arg.data.coach.rounds["1"].players["us player 3"].nudge).toBe(0);
    // Keyed by our player on that table, never by table number; the round records its opponent.
    expect(arg.data.coach.rounds["1"].opp).toBe("Near A");
    expect(arg.data.coach.rounds["1"]).not.toHaveProperty("tables");
    // Closed, and the toast says what happened.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Table 3: 18-2 saved")).toBeTruthy();
  });

  // t-736 (g): a lock-built round's table number is lock order, so the entry must name the player.
  it("on the lock-built round, choosing 18 writes players[normalized us] and the round's opponent", async () => {
    acceptSaves();
    window.localStorage.setItem("wdc.pin", "4321");
    const board = makeLockBoard();
    const lockTable3 = board.rounds[1].tables[2];
    expect(lockTable3.us).toBe("Us Player 6"); // lock order is not roster order
    load(board);
    const pad = await openPad(3);
    await tap(within(pad).getByRole("button", { name: "18" }));
    expect(mocks.save).toHaveBeenCalledTimes(1);
    const sent = mocks.save.mock.calls[0][0].data.coach as WdcBoardState["coach"];
    expect(sent.rounds["2"].opp).toBe("Near B");
    expect(sent.rounds["2"].players).toEqual({ "us player 6": { score: 18, nudge: 0 } });
    expect(sent.rounds["2"]).not.toHaveProperty("tables");
    expect(sent.rounds["1"]).toBeUndefined();
  });

  it("closes on Back and on Escape without saving", async () => {
    load(makeBoard());
    await openPad(2);
    await tap(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await openPad(2);
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("clears a coach score with Clear score", async () => {
    window.localStorage.setItem("wdc.pin", "1234"); // a tablet that has saved before
    acceptSaves();
    const board = makeBoard();
    board.rounds[0].tables[2].coachScore = 11;
    load(board);
    await openPad(3);
    await tap(screen.getByRole("button", { name: "Clear score" }));
    expect(
      mocks.save.mock.calls[0][0].data.coach.rounds["1"].players["us player 3"].score,
    ).toBeNull();
    expect(screen.getByText("Table 3 cleared")).toBeTruthy();
  });

  it("shows the PIN field on pin-unset, keeps the pad open, and retries with the entered PIN", async () => {
    window.localStorage.setItem("wdc.pin", "1234"); // a tablet that has saved before
    mocks.save.mockResolvedValueOnce({
      ok: false,
      reason: "pin-unset",
      message: "Coach PIN not set",
    });
    load(makeBoard());
    const pad = await openPad(3);
    await tap(within(pad).getByRole("button", { name: "18" }));
    expect(screen.getByRole("alert").textContent).toBe("Coach PIN not set");
    const input = screen.getByLabelText("Coach PIN") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(screen.getByRole("dialog")).toBeTruthy(); // the pad stays up behind the PIN entry

    acceptSaves();
    await act(async () => {
      fireEvent.change(input, { target: { value: "2468" } });
    });
    await tap(screen.getByRole("button", { name: "Save with PIN" }));
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.save.mock.calls[1][0].data.pin).toBe("2468");
    expect(mocks.save.mock.calls[1][0].data.coach.rounds["1"].players["us player 3"].score).toBe(
      18,
    );
    expect(window.localStorage.getItem("wdc.pin")).toBe("2468");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Table 3: 18-2 saved")).toBeTruthy();
  });

  it("asks for the PIN before sending anything on a tablet with no PIN, and holds taps behind it", async () => {
    load(makeBoard());
    const card = () => screen.getAllByRole("article")[0];
    await tap(within(card()).getByRole("button", { name: /Forecast one higher for table 1/ }));
    expect(mocks.save).not.toHaveBeenCalled(); // no blank PIN ever reaches the server
    expect(screen.getByRole("alert").textContent).toBe("Enter the coach PIN");
    // a second tap while the box is open is held, not sent
    await tap(within(card()).getByRole("button", { name: /Forecast one higher for table 1/ }));
    expect(mocks.save).not.toHaveBeenCalled();

    acceptSaves();
    const input = screen.getByLabelText("Coach PIN") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "Warpdust" } });
    });
    await tap(screen.getByRole("button", { name: "Save with PIN" }));
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save.mock.calls[0][0].data.pin).toBe("Warpdust");
    expect(mocks.save.mock.calls[0][0].data.coach.rounds["1"].players["us player 1"].nudge).toBe(2);
    expect(window.localStorage.getItem("wdc.pin")).toBe("Warpdust");
  });

  it("nudges the forecast all the way to 20 and down to 0, and stops there", async () => {
    window.localStorage.setItem("wdc.pin", "1234");
    // the server merges the saved nudges into the board it returns
    mocks.save.mockImplementation(async ({ data }: { data: { coach: WdcBoardState["coach"] } }) => {
      const state = applyCoach(makeBoard({ coach: data.coach }), data.coach);
      mocks.get.mockResolvedValue(state); // the refresh after the save sees it too
      return { ok: true, state };
    });
    load(makeBoard());
    const card = () => screen.getAllByRole("article")[0];
    const up = () =>
      within(card()).getByRole("button", { name: /Forecast one higher for table 1/ });
    const down = () =>
      within(card()).getByRole("button", { name: /Forecast one lower for table 1/ });
    for (let i = 0; i < 12; i++) await tap(up());
    expect(within(card()).getByText(/^Forecast/).textContent).toMatch(/Forecast 20-0/);
    const sent = mocks.save.mock.calls.length;
    await tap(up()); // already 20: nothing more is sent
    expect(mocks.save.mock.calls.length).toBe(sent);
    for (let i = 0; i < 22; i++) await tap(down());
    expect(within(card()).getByText(/^Forecast/).textContent).toMatch(/Forecast 0-20/);
  });

  it("forgets a stored PIN the server refuses, so it is not sent again", async () => {
    window.localStorage.setItem("wdc.pin", "old");
    mocks.save.mockResolvedValueOnce({ ok: false, reason: "pin", message: "Wrong PIN" });
    load(makeBoard());
    const card = () => screen.getAllByRole("article")[0];
    await tap(within(card()).getByRole("button", { name: /Forecast one higher for table 1/ }));
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem("wdc.pin")).toBeNull();
  });

  it("asks for the PIN when a nudge is refused, and shifts the forecast on success", async () => {
    window.localStorage.setItem("wdc.pin", "1234"); // a tablet that has saved before
    mocks.save.mockResolvedValueOnce({ ok: false, reason: "pin", message: "Wrong PIN" });
    load(makeBoard());
    const card = () => screen.getAllByRole("article")[0];
    const before = within(card()).getByText(/^Forecast/).textContent;
    await tap(within(card()).getByRole("button", { name: /Forecast one higher for table 1/ }));
    expect(mocks.save.mock.calls[0][0].data.coach.rounds["1"].players["us player 1"].nudge).toBe(1);
    expect(screen.getByRole("alert").textContent).toBe("Wrong PIN");
    expect(before).toMatch(/Forecast 11-9/);
    expect(within(card()).getByText(/^Forecast/).textContent).toMatch(/Forecast 12-8/); // optimistic until refused for good

    await tap(screen.getByRole("button", { name: "Cancel" }));
    expect(within(card()).getByText(/^Forecast/).textContent).toMatch(/Forecast 11-9/); // rolled back
  });
});

// t-739: the coach's forecast weights (docs/HISTORY.md) and the BCP player history behind them.
describe("board forecast weights", () => {
  const card1 = () => screen.getAllByRole("article")[0];
  const shown = () => within(card1()).getByText(/^Forecast/).textContent ?? "";
  const withHistory = () => {
    mocks.history.players = makeHistory().players;
  };
  const openWeights = async () => {
    await tap(screen.getByRole("button", { name: "Weights" }));
    return screen.getByRole("dialog", { name: "Forecast weights" });
  };

  it("opens a sheet of three weights at their defaults, each with 44px minus and plus", async () => {
    const { container } = load(makeBoard());
    const sheet = await openWeights();
    expect(screen.getByRole("button", { name: "Weights" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    for (const [label, value] of [
      ["Faction matchups", "1.0x"],
      ["11th edition form", "0.5x"],
      ["11th vs this army", "1.0x"],
    ]) {
      const group = within(sheet).getByRole("group", { name: `${label} weight` });
      expect(group.textContent).toContain(value);
      expect(within(group).getByRole("button", { name: `Lower ${label} weight` })).toBeTruthy();
      expect(within(group).getByRole("button", { name: `Raise ${label} weight` })).toBeTruthy();
    }
    expect(
      (within(sheet).getByRole("button", { name: "Reset to defaults" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // 44px targets: the header button, the sheet's step buttons, Done and Reset
    const css = container.querySelector("style")?.textContent ?? "";
    expect(css).toMatch(/\.wdc \.wbtn\{min-height:44px/);
    expect(css).toMatch(/\.wdc \.wctl button\{min-width:44px;min-height:44px/);
    expect(css).toMatch(/\.wdc \.whead \.x\{min-width:44px;min-height:44px/);
    expect(css).toMatch(/\.wdc \.wfoot \.wreset\{min-height:44px/);
    // an overlay, not inline: the one-screen layout keeps its height
    expect(css).toMatch(/\.wdc \.wsheet\{position:fixed;inset:0/);
    // Done and Escape close it
    await tap(within(sheet).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await openWeights();
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("tapping plus on Form saves weights.form 0.75 and moves the board's forecasts", async () => {
    withHistory();
    acceptSaves();
    window.localStorage.setItem("wdc.pin", "4321");
    const board = makeBoard();
    const us = board.teams[OUR].players[0];
    const them = board.teams["Near A"].players[0];
    const before = pairForecast(us, them, 0, { weights: DEFAULT_WEIGHTS }).points;
    const after = pairForecast(us, them, 0, { weights: { ...DEFAULT_WEIGHTS, form: 0.75 } }).points;
    expect(after).not.toBe(before);
    load(board);
    expect(shown()).toContain(`${before}-${20 - before}`);
    expect(
      screen.getByText(/Forecasts also use Stat Check faction matchups \(/).textContent,
    ).toMatch(
      /and BCP 11th edition player history \(form and results vs each army\), scaled by Weights\.$/,
    );

    const sheet = await openWeights();
    await tap(within(sheet).getByRole("button", { name: "Raise 11th edition form weight" }));
    expect(mocks.save).toHaveBeenCalledTimes(1);
    const arg = mocks.save.mock.calls[0][0];
    expect(arg.data.pin).toBe("4321");
    expect(arg.data.coach.weights).toEqual({ faction: 1, form: 0.75, history: 1 });
    // the rest of the document travels unchanged
    expect(arg.data.coach.rounds).toEqual(board.coach.rounds);
    expect(arg.data.coach.pairing).toEqual(board.coach.pairing);
    expect(
      within(sheet).getByRole("group", { name: "11th edition form weight" }).textContent,
    ).toContain("0.75x");
    expect(shown()).toContain(`${after}-${20 - after}`);
    expect(screen.getByText("Weights saved")).toBeTruthy();

    // Reset restores the defaults and the forecast
    await tap(within(sheet).getByRole("button", { name: "Reset to defaults" }));
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.save.mock.calls[1][0].data.coach.weights).toEqual(DEFAULT_WEIGHTS);
    expect(
      within(sheet).getByRole("group", { name: "11th edition form weight" }).textContent,
    ).toContain("0.5x");
    expect(shown()).toContain(`${before}-${20 - before}`);
  });

  it("puts the history numbers in the pairing cell label and marks a 2+ shift with H", async () => {
    withHistory();
    const board = makeBoard({
      coach: { rounds: {}, pairing: { opp: "Near A", locks: [] }, eloOverrides: {} },
    });
    load(board);
    await tap(screen.getByRole("tab", { name: "Pairing" }));
    const cell = screen.getByRole("button", { name: /^Us Player 1 vs NearA Player 1,/ });
    const hist =
      "Us Player 1 (World Eaters, Purge the Foe) 5W 0D 0L into World Eaters in 11th; 18W 0D 2L in 11th overall. " +
      "NearA Player 1 1W 0D 3L into World Eaters in 11th; 2W 0D 10L in 11th overall";
    expect(cell.getAttribute("aria-label")).toContain(`, ${hist}`);
    expect(cell.getAttribute("title")).toBe(hist);
    expect(cell.querySelector(".hx")?.textContent).toBe("H");
    // a pair with no history in the snapshot: no numbers, no marker
    const plain = screen.getByRole("button", { name: /^Us Player 3 vs NearA Player 3,/ });
    expect(plain.getAttribute("title")).toBeNull();
    expect(plain.querySelector(".hx")).toBeNull();
    expect(screen.getByText(/H: history moved it 2\+, F: faction moved it 2\+\)/)).toBeTruthy();
  });

  it("forecasts with the weights the board's coach document carries", () => {
    withHistory();
    const board = makeBoard({
      coach: {
        rounds: {},
        pairing: { opp: "", locks: [] },
        eloOverrides: {},
        weights: { faction: 1, form: 0, history: 0 },
      },
    });
    const us = board.teams[OUR].players[0];
    const them = board.teams["Near A"].players[0];
    const f = pairForecast(us, them, 0, { weights: { faction: 1, form: 0, history: 0 } });
    expect(f.points).toBe(f.eloOnly); // a mirror with history switched off: Elo only
    load(board);
    expect(shown()).toContain(`${f.points}-${20 - f.points}`);
  });
});

// t-740: touch screens never show title text, so the last tapped pairing cell's forecast, faction
// matchup and history numbers show as visible text in a detail line above the grid.
describe("board pairing detail line", () => {
  const nearA = () =>
    makeBoard({ coach: { rounds: {}, pairing: { opp: "Near A", locks: [] }, eloOverrides: {} } });
  const openPairing = async () => {
    await tap(screen.getByRole("tab", { name: "Pairing" }));
  };
  const cell = (u: number, t: number) =>
    screen.getByRole("button", { name: new RegExp(`^Us Player ${u} vs NearA Player ${t},`) });
  const lineText = (c: HTMLElement) => c.querySelector(".pdetail")?.textContent ?? "";
  const shownText = (c: HTMLElement) => c.querySelector(".pdetail .pdl .t")?.textContent ?? "";
  const LEGEND =
    /^Green favors us, red against \(H: history moved it 2\+, F: faction moved it 2\+\)/;
  const HIST =
    "Us Player 1 (World Eaters, Purge the Foe) 5W 0D 0L into World Eaters in 11th; 18W 0D 2L in 11th overall. " +
    "NearA Player 1 1W 0D 3L into World Eaters in 11th; 2W 0D 10L in 11th overall";

  it("shows the tapped cell's forecast and history record as text, not only in its label", async () => {
    mocks.history.players = makeHistory().players;
    acceptSaves();
    window.localStorage.setItem("wdc.pin", "1234");
    const board = nearA();
    const f = pairForecast(board.teams[OUR].players[0], board.teams["Near A"].players[0], 0, {
      weights: DEFAULT_WEIGHTS,
    });
    expect(f.points).not.toBe(f.eloOnly); // the fixture history moves this pair
    const { container } = load(board);
    await openPairing();
    // Before any tap the line carries the legend and no detail.
    expect(lineText(container)).toMatch(LEGEND);
    expect(container.querySelector(".pdl")).toBeNull();

    await tap(cell(1, 1));
    const v = f.points;
    const expected =
      `Us Player 1 vs NearA Player 1: forecast ${v}-${20 - v} (Elo alone ${f.eloOnly}-${20 - f.eloOnly})` +
      (f.matchup ? `. ${matchupLabel(f.matchup)}` : "") +
      `. ${HIST}`;
    expect(shownText(container)).toBe(expected);
    // A rendered text node (what a touch screen shows), found by text, not by attribute.
    expect(screen.getByText(expected).closest(".pdetail")).toBeTruthy();
    // The tap still locked the pairing, and the cell keeps its label and title.
    expect(cell(1, 1).className).toContain("lock");
    expect(cell(1, 1).getAttribute("title")).toBe(HIST);
    expect(cell(1, 1).getAttribute("aria-label")).toContain(`, ${HIST}`);

    // Tapping it again unlocks it, and the line still reads that cell.
    await tap(cell(1, 1));
    expect(cell(1, 1).className).not.toContain("lock");
    expect(shownText(container)).toBe(expected);
  });

  it("shows the faction matchup, and a second tapped cell replaces the first", async () => {
    window.localStorage.setItem("wdc.pin", "1234");
    // The real snapshot's most lopsided matchup, as in the faction edge test above.
    const flat = { elo: 1500, eloKnown: true, team: "", dispo: "", list: null };
    let pick: { us: string; them: string; shift: number } | null = null;
    for (const [us, opps] of Object.entries(MATCHUPS.rows)) {
      for (const them of Object.keys(opps)) {
        const g = pairForecast(
          { ...flat, name: "a", faction: us },
          { ...flat, name: "b", faction: them },
        );
        if (!pick || g.points - g.eloOnly > pick.shift)
          pick = { us, them, shift: g.points - g.eloOnly };
      }
    }
    const board = nearA();
    const us = board.teams[OUR].players;
    const them = board.teams["Near A"].players;
    us[1].faction = pick!.us;
    them[1].faction = pick!.them;
    // A pair with no faction row and no history: the plain Elo forecast.
    us[2].faction = "Unlisted Army One";
    them[2].faction = "Unlisted Army Two";
    const f = pairForecast(us[1], them[1]);
    const plain = pairForecast(us[2], them[2]);
    expect(f.matchup).not.toBeNull();
    expect(f.points).not.toBe(f.eloOnly);
    expect(plain.matchup).toBeNull();
    // The server echoes this board (its factions included) with the saved coach document.
    mocks.save.mockImplementation(async ({ data }: { data: { coach: WdcBoardState["coach"] } }) => {
      const state = { ...board, coach: data.coach };
      mocks.get.mockResolvedValue(state);
      return { ok: true, state };
    });
    const { container } = load(board);
    await openPairing();

    await tap(cell(2, 2));
    const label = matchupLabel(f.matchup!);
    expect(shownText(container)).toBe(
      `Us Player 2 vs NearA Player 2: forecast ${f.points}-${20 - f.points} (Elo alone ${f.eloOnly}-${20 - f.eloOnly}). ${label}`,
    );
    expect(screen.getByText(/^Us Player 2 vs NearA Player 2: forecast/)).toBeTruthy();

    await tap(cell(3, 3));
    const v = plain.points;
    expect(shownText(container)).toBe(
      `Us Player 3 vs NearA Player 3: forecast ${v}-${20 - v}, Elo only`,
    );
    expect(lineText(container)).not.toContain("Faction matchup");
    expect(lineText(container)).not.toContain("Us Player 2");
    expect(container.querySelectorAll(".pdetail")).toHaveLength(1);
  });

  it("expands to a sheet with the full text and the legend, and a new opponent clears it", async () => {
    mocks.history.players = makeHistory().players;
    acceptSaves();
    window.localStorage.setItem("wdc.pin", "1234");
    const { container } = load(nearA());
    await openPairing();
    await tap(cell(1, 1));
    const more = container.querySelector(".pdl") as HTMLButtonElement;
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await tap(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const sheet = screen.getByRole("region", { name: "Pairing detail" });
    expect(sheet.textContent).toContain(HIST);
    expect(within(sheet).getByText(LEGEND)).toBeTruthy();
    await tap(within(sheet).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("region", { name: "Pairing detail" })).toBeNull();
    await tap(more);
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(screen.queryByRole("region", { name: "Pairing detail" })).toBeNull();

    // A pick from another opponent's grid is not shown against the new one.
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Opponent"), { target: { value: "Near B" } });
    });
    expect(container.querySelector(".pdl")).toBeNull();
    expect(lineText(container)).toMatch(LEGEND);
  });

  it("styles the line for both layouts: wrapping 44px on a phone, one line on tablets", async () => {
    const { container } = load(nearA());
    await openPairing();
    const css = container.querySelector("style")?.textContent ?? "";
    const at = css.indexOf("@media (min-width:900px) and (orientation:landscape)");
    const phone = css.slice(0, at);
    const tablet = css.slice(at);
    // The line is in the DOM whatever the width, and no rule hides it.
    expect(container.querySelectorAll(".pair .pdetail")).toHaveLength(1);
    expect(css).not.toMatch(/\.wdc \.pdetail[^{]*\{[^}]*display:none/);
    // Phone (no media query): a 44px button whose text wraps, stuck to the top once a cell is tapped.
    expect(phone).toMatch(/\.wdc \.pdl\{[^}]*min-height:44px/);
    expect(phone).toMatch(/\.wdc \.pdl \.t\{[^}]*overflow-wrap:anywhere/);
    expect(phone).toMatch(/\.wdc \.pdetail\.on\{position:sticky;top:0/);
    expect(phone).toMatch(/\.wdc \.dsheet \.x\{[^}]*min-width:44px;min-height:44px/);
    // Tablet: one 19px line with ellipsis; the 44px target adds no layout height; the sheet overlays.
    expect(tablet).toMatch(/\.wdc \.pdl\{[^}]*height:44px;padding:12\.5px 0;margin:-12\.5px 0/);
    expect(tablet).toMatch(/\.wdc \.pdl \.in\{[^}]*height:19px;[^}]*white-space:nowrap/);
    expect(tablet).toMatch(/\.wdc \.pdl \.t\{[^}]*text-overflow:ellipsis/);
    expect(tablet).toMatch(/\.wdc \.dsheet\{position:absolute/);
  });
});

describe("board route shell", () => {
  it("carries the tablet one-screen layout and no site chrome", () => {
    const { container } = load(makeBoard());
    expect(container.innerHTML).toContain("orientation:landscape");
    expect(container.innerHTML).toContain("min-width:900px");
    expect(container.querySelector("header.top")).toBeTruthy();
    // Only the board's own header: no site footer or contentinfo landmark.
    expect(container.querySelector("footer")).toBeNull();
    expect(screen.queryByRole("contentinfo")).toBeNull();
  });

  it("keeps every interactive control at least 44px tall, tablet block included", () => {
    const { container } = load(makeBoard());
    const css = container.querySelector("style")?.textContent ?? "";
    const heights = [...css.matchAll(/min-height:(\d+)px/g)].map((m) => Number(m[1]));
    expect(css).toContain("min-height:44px");
    // Every declared min-height is 44 or more (0 is a flex shrink guard).
    const small = heights.filter((h) => h > 0 && h < 44);
    expect(small).toEqual([]);
    // The tablet block alone: its nudge buttons keep 44px in both axes.
    const tablet = css.slice(css.indexOf("@media (min-width:900px) and (orientation:landscape)"));
    expect(tablet).toMatch(/\.wdc \.nudge button\{[^}]*min-width:44px;min-height:44px/);
  });

  it("gives the tablet opponent select a selector that outranks the bar's flex:0 0 auto", () => {
    const { container } = load(makeBoard());
    const css = container.querySelector("style")?.textContent ?? "";
    const tablet = css.slice(css.indexOf("@media (min-width:900px) and (orientation:landscape)"));
    // `.wdc .pair .bar>*` is three classes; the select rule must be three classes plus an element.
    expect(tablet).toContain(".wdc .pair .bar>*{flex:0 0 auto}");
    expect(tablet).toMatch(/\.wdc \.pair \.bar select\{flex:0 1 190px;[^}]*text-overflow:ellipsis/);
    // No lower-specificity `.wdc .pair select` flex rule is left in the tablet block to lose the cascade.
    expect(tablet).not.toMatch(/\.wdc \.pair select\{[^}]*flex:/);
    // The card forecast bar and the matrix LIST links keep usable sizes.
    expect(tablet).toMatch(/\.wdc \.pred \.bar\{[^}]*min-width:20px/);
    expect(tablet).toMatch(/\.wdc \.ph a\{[^}]*padding:5px 8px;margin:-5px -8px/);
  });

  it("sets the title, noindex robots and the font stylesheet in index.html", () => {
    const html = readFileSync(join(ROOT, "index.html"), "utf8");
    expect(html).toContain("<title>Warp Dust Coach Board</title>");
    expect(html).toMatch(/<meta name="robots" content="noindex,nofollow" \/>/);
    const font = html.match(/<link\s+rel="stylesheet"\s+href="([^"]+)"/);
    expect(font?.[1]).toContain("https://fonts.bunny.net/");
    expect(font?.[1]).toContain("saira");
    expect(font?.[1]).toContain("barlow");
    expect(html).not.toContain("fonts.googleapis.com");
  });

  it("loads the first board through getWdcBoard, then shows it", async () => {
    const board = makeBoard();
    mocks.get.mockResolvedValue(board);
    render(<App />);
    expect(screen.getByRole("status").textContent).toContain("Loading the board");
    expect(await screen.findAllByRole("article")).toHaveLength(8);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("says when the server cannot be reached, and Try again loads the board", async () => {
    mocks.get.mockRejectedValueOnce(new Error("offline"));
    render(<App />);
    expect((await screen.findByRole("alert")).textContent).toContain("Could not reach the server");
    mocks.get.mockResolvedValue(makeBoard());
    await tap(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findAllByRole("article")).toHaveLength(8);
  });

  it("ships no em-dash character in any source, doc or page file", () => {
    const dash = String.fromCharCode(0x2014);
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    const files = [
      ...walk(join(ROOT, "src")),
      ...walk(join(ROOT, "docs")).filter((f) => f.endsWith(".md")),
      ...walk(join(ROOT, "scripts")),
      join(ROOT, "index.html"),
      join(ROOT, "README.md"),
      join(ROOT, "wrangler.jsonc"),
    ];
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) expect(readFileSync(f, "utf8").includes(dash), f).toBe(false);
  });
});

// t-734: one save in flight with the newest document coalesced behind it, stale polls discarded by
// epoch, the ninth rostered player, the "unavailable" lockout reply, and the phone pad grid.
describe("board save queue and poll race", () => {
  type Reply = { ok: true; state: WdcBoardState } | { ok: false; reason: string; message: string };
  const defer = <T,>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  };
  const tick = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
  };
  const forecast = () =>
    within(screen.getAllByRole("article")[0]).getByText(/^Forecast/).textContent ?? "";
  const nudgeUp = () =>
    tap(screen.getByRole("button", { name: /Forecast one higher for table 1/ }));
  const withNudge = (n: number) => {
    const b = makeBoard();
    b.rounds[0].tables[0].nudge = n;
    return b;
  };
  type SaveArg = { data: { coach: WdcBoardState["coach"] } };
  // The server takes the nudge and answers with table 1 nudged up one.
  const acceptNudged = () =>
    mocks.save.mockImplementation(async ({ data }: SaveArg) => ({
      ok: true,
      state: makeBoard({ coach: data.coach, rounds: withNudge(1).rounds }),
    }));
  const setTablesBtn = () =>
    screen.getByRole("button", { name: /Set tables for round 2/ }) as HTMLButtonElement;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("keeps one save in flight and lands all 8 locks when replies would arrive out of order", async () => {
    window.localStorage.setItem("wdc.pin", "1234");
    let stored: WdcBoardState["coach"] | null = null;
    let live = 0;
    let peak = 0;
    let n = 0;
    // Each later call answers sooner, so parallel saves would land oldest-last and lose locks.
    mocks.save.mockImplementation(({ data }: SaveArg) => {
      live += 1;
      peak = Math.max(peak, live);
      const delay = 800 - 80 * n++;
      return new Promise<Reply>((res) =>
        setTimeout(() => {
          live -= 1;
          stored = data.coach;
          const state = makeBoard({ coach: data.coach });
          mocks.get.mockResolvedValue(state);
          res({ ok: true, state });
        }, delay),
      );
    });
    load(
      makeBoard({ coach: { rounds: {}, pairing: { opp: "Near A", locks: [] }, eloOverrides: {} } }),
    );
    await tap(screen.getByRole("tab", { name: "Pairing" }));
    const cell = (u: number, t: number) =>
      screen.getByRole("button", { name: new RegExp(`^Us Player ${u} vs NearA Player ${t},`) });
    for (let i = 1; i <= 8; i++) await tap(cell(i, i));
    // Optimistic: all eight show at once, with one save out and the rest coalesced behind it.
    expect(screen.getByText(/8 of 8 locked/)).toBeTruthy();
    expect(mocks.save).toHaveBeenCalledTimes(1);
    for (let k = 0; k < 4; k++) await tick(1000);
    expect(peak).toBe(1);
    expect(mocks.save).toHaveBeenCalledTimes(2); // the first tap, then the coalesced latest document
    const want = Array.from({ length: 8 }, (_, i) => ({
      us: `Us Player ${i + 1}`,
      them: `NearA Player ${i + 1}`,
    }));
    expect(stored!.pairing.locks).toEqual(want);
    expect(mocks.save.mock.calls.at(-1)![0].data.coach.pairing.locks).toEqual(want);
    expect(screen.getByText(/8 of 8 locked/)).toBeTruthy();
    expect(setTablesBtn().disabled).toBe(false);
  });

  it("discards a poll that began before a save and lands after it", async () => {
    window.localStorage.setItem("wdc.pin", "1234"); // a tablet that has saved before
    load(makeBoard());
    const poll = defer<WdcBoardState>();
    mocks.get.mockReturnValueOnce(poll.promise);
    await tick(30_000); // the poll starts and waits on the old board
    expect(mocks.get).toHaveBeenCalledTimes(1);
    const after = defer<WdcBoardState>();
    mocks.get.mockReturnValueOnce(after.promise); // the refresh that follows the save
    acceptNudged();
    await nudgeUp();
    expect(mocks.save).toHaveBeenCalledTimes(1); // the race is real only if the save was sent
    await flush();
    expect(forecast()).toMatch(/12-8/);
    poll.resolve(makeBoard()); // stale: nudge 0
    await flush();
    expect(forecast()).toMatch(/12-8/);
    after.resolve(withNudge(1));
    await flush();
    expect(forecast()).toMatch(/12-8/);
  });

  it("discards a stale poll that lands after the post-save refresh", async () => {
    window.localStorage.setItem("wdc.pin", "1234"); // a tablet that has saved before
    load(makeBoard());
    const poll = defer<WdcBoardState>();
    mocks.get.mockReturnValueOnce(poll.promise);
    await tick(30_000);
    mocks.get.mockReturnValueOnce(Promise.resolve(withNudge(1)));
    acceptNudged();
    await nudgeUp();
    await flush();
    expect(mocks.get).toHaveBeenCalledTimes(2); // the post-save refresh already landed
    expect(forecast()).toMatch(/12-8/);
    poll.resolve(makeBoard()); // stale, last
    await flush();
    expect(forecast()).toMatch(/12-8/);
  });

  it("arms Set tables at 8 locks when our team rosters 9 and still lists all 9 as rows", async () => {
    const board = makeBoard({
      coach: {
        rounds: {},
        pairing: {
          opp: "Near A",
          locks: Array.from({ length: 8 }, (_, i) => ({
            us: `Us Player ${i + 1}`,
            them: `NearA Player ${i + 1}`,
          })),
        },
        eloOverrides: {},
      },
    });
    const ours = board.teams[OUR].players;
    ours.push({ ...ours[0], name: "Us Player 9", list: "uslist9" });
    load(board);
    await tap(screen.getByRole("tab", { name: "Pairing" }));
    const cells = screen.getAllByRole("button", { name: /^Us Player \d vs NearA Player \d,/ });
    expect(cells).toHaveLength(72);
    expect(screen.getByText(/8 of 8 locked/)).toBeTruthy();
    expect(setTablesBtn().disabled).toBe(false);
    // The substitute's row is listed but cannot take a ninth lock.
    const sub = screen.getAllByRole("button", { name: /^Us Player 9 vs NearA Player \d,/ });
    expect(sub).toHaveLength(8);
    expect(sub.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it("toasts an unavailable reply, closes the PIN form, rolls back and keeps polling", async () => {
    window.localStorage.setItem("wdc.pin", "1234"); // a tablet that has saved before
    mocks.save.mockResolvedValueOnce({ ok: false, reason: "pin", message: "Wrong PIN" });
    load(makeBoard());
    await nudgeUp();
    await flush();
    const input = screen.getByLabelText("Coach PIN") as HTMLInputElement;
    mocks.save.mockResolvedValueOnce({
      ok: false,
      reason: "unavailable",
      message: "Too many tries",
    });
    await act(async () => {
      fireEvent.change(input, { target: { value: "0000" } });
    });
    await tap(screen.getByRole("button", { name: "Save with PIN" }));
    await flush();
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Too many tries")).toBeTruthy();
    expect(screen.queryByLabelText("Coach PIN")).toBeNull();
    expect(forecast()).toMatch(/11-9/); // rolled back
    mocks.get.mockClear();
    await tick(30_000);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("sizes the pad columns with minmax(0,1fr) so seven keys fit a phone", () => {
    const { container } = load(makeBoard());
    const css = container.querySelector("style")?.textContent ?? "";
    expect(css).toMatch(/\.wdc \.keys\{[^}]*grid-template-columns:repeat\(7,minmax\(0,1fr\)\)/);
    expect(css).not.toContain("repeat(7,1fr)");
    // Below 560px the keys drop the 1.15 ratio that forced a 64.4px minimum column.
    const phone = /@media \(max-width:560px\)\{[^\n]*\.wdc \.keys button\{[^}]*aspect-ratio:auto/;
    expect(css).toMatch(phone);
  });
});
