import { useEffect, useState } from "react";
import { Home } from "./components/Home";
import { Editor } from "./components/Editor";
import { EMPTY_APP_STATE, loadAppState, clearAppState } from "./lib/db";
import type { AppState } from "./lib/types";

function App() {
  const [appState, setAppState] = useState<AppState | null>(null);

  useEffect(() => {
    loadAppState().then(setAppState);
  }, []);

  async function handleStartOver() {
    await clearAppState();
    setAppState(EMPTY_APP_STATE);
  }

  if (appState === null) {
    return (
      <div className="flex h-screen w-screen items-center justify-center text-neutral-400">
        Loading…
      </div>
    );
  }

  return (
    <div className="h-screen w-screen bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      {appState.currentImageDataUrl ? (
        <Editor appState={appState} onAppStateChange={setAppState} onStartOver={handleStartOver} />
      ) : (
        <Home onReady={setAppState} />
      )}
    </div>
  );
}

export default App;
