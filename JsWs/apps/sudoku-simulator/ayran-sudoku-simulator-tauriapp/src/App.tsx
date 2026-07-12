import { useState } from "react";
import { GameProvider, useGame } from "./state/GameContext";
import { ThemeProvider } from "./state/ThemeContext";
import { SudokuGrid } from "./components/board/SudokuGrid";
import { NumberPad } from "./components/board/NumberPad";
import { CellStyleModal } from "./components/board/CellStyleModal";
import { SaveSnapshotModal } from "./components/snapshots/SaveSnapshotModal";
import { SnapshotTree } from "./components/snapshots/SnapshotTree";
import { ImportBoardModal } from "./components/import/ImportBoardModal";
import { ThemeSettings } from "./components/theme/ThemeSettings";

type View = "board" | "snapshots" | "theme";

function AppShell() {
  const { loaded, resetBoard } = useGame();
  const [view, setView] = useState<View>("board");

  if (!loaded) {
    return <div className="flex h-screen items-center justify-center text-gray-500">Loading…</div>;
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 bg-[var(--theme-bg)] p-4 text-[var(--theme-fg)]">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-bold">Ayran Sudoku Simulator</h1>
        <nav className="flex gap-1 rounded-md bg-gray-100 p-1">
          <button
            type="button"
            onClick={() => setView("board")}
            className={`rounded px-3 py-1.5 text-sm font-medium ${view === "board" ? "bg-white shadow-sm" : "text-gray-500"}`}
          >
            Board
          </button>
          <button
            type="button"
            onClick={() => setView("snapshots")}
            className={`rounded px-3 py-1.5 text-sm font-medium ${view === "snapshots" ? "bg-white shadow-sm" : "text-gray-500"}`}
          >
            Snapshots
          </button>
          <button
            type="button"
            onClick={() => setView("theme")}
            className={`rounded px-3 py-1.5 text-sm font-medium ${view === "theme" ? "bg-white shadow-sm" : "text-gray-500"}`}
          >
            Theme
          </button>
        </nav>
      </header>

      {view === "board" && (
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start sm:justify-center">
          <SudokuGrid />
          <div className="flex w-full max-w-xs flex-col gap-3">
            <NumberPad />
            <CellStyleModal />
            <div className="my-1 border-t border-gray-200" />
            <SaveSnapshotModal />
            <ImportBoardModal />
            <button
              type="button"
              onClick={() => {
                if (confirm("Clear the board back to blank? This does not delete saved snapshots.")) {
                  resetBoard();
                }
              }}
              className="w-full rounded-md border border-gray-300 bg-white py-2 text-sm font-medium text-gray-700 shadow-sm"
            >
              New blank board
            </button>
          </div>
        </div>
      )}

      {view === "snapshots" && <SnapshotTree />}

      {view === "theme" && <ThemeSettings />}
    </div>
  );
}

function App() {
  return (
    <ThemeProvider>
      <GameProvider>
        <AppShell />
      </GameProvider>
    </ThemeProvider>
  );
}

export default App;
