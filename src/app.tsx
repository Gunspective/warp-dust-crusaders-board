import { useCallback, useEffect, useState } from "react";
import { getWdcBoard } from "./lib/api/wdc.functions";
import type { WdcBoardState } from "./lib/wdc/types";
import { WdcBoard } from "./components/wdc/wdc-board";
import { WDC_CSS } from "./components/wdc/wdc-styles";

// The Warp Dust Crusaders coach board (contract: docs/CONTRACT.md). A full-screen tool for the
// team: noindex, not linked from anywhere. The first board comes from GET /api/board (the old
// route loader); after that WdcBoard polls on its own. The page look is the team's (Saira + Barlow
// from Bunny Fonts, see index.html; dark ground, warp magenta), scoped under .wdc.

type Load = { kind: "loading" } | { kind: "ready"; board: WdcBoardState } | { kind: "error" };

export function App() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  const fetchBoard = useCallback(async () => {
    setLoad({ kind: "loading" });
    try {
      setLoad({ kind: "ready", board: await getWdcBoard() });
    } catch {
      setLoad({ kind: "error" });
    }
  }, []);

  useEffect(() => {
    void fetchBoard();
  }, [fetchBoard]);

  if (load.kind === "ready") return <WdcBoard initial={load.board} />;
  return (
    <div className="wdc">
      <style>{WDC_CSS}</style>
      <header className="top">
        <h1>
          Warp Dust <span>Coach Board</span>
        </h1>
      </header>
      <main className="app">
        {load.kind === "loading" ? (
          <div className="empty" role="status">
            Loading the board.
          </div>
        ) : (
          <div className="empty" role="alert">
            Could not reach the server.{" "}
            <button type="button" className="wbtn" onClick={() => void fetchBoard()}>
              Try again
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
