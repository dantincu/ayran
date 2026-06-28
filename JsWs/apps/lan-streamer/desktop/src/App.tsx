import { useEffect, useState } from "react";
import { LoginScreen } from "./components/LoginScreen";
import { HostPanel } from "./components/HostPanel";
import { ListenerPanel } from "./components/ListenerPanel";
import * as api from "./lib/api";
import { ApiError } from "./lib/api";
import { clearSession, loadSession, saveSession } from "./lib/sessionStore";
import type { Session } from "./lib/types";

// This used to be exclusive ("host" XOR "listener", never both) - now it's
// just which panel is visually in front; both stay mounted and active under
// the hood the whole time (see the main element below), so you can host one
// stream and listen to another simultaneously.
type View = "host" | "listener";

export default function App() {
  const [session, setSession] = useState<Session>();
  const [view, setView] = useState<View>("host");
  const [restoring, setRestoring] = useState(true);

  useEffect(() => {
    loadSession()
      .then(async (restored) => {
        if (!restored) return;
        // Verify the token still works before trusting it - but only clear
        // the stored credential if the API explicitly rejected it (401).
        // Any other failure (API unreachable, DNS hiccup, a redeploy still
        // settling, etc.) is transient and shouldn't destroy a perfectly
        // valid session just because this one check couldn't complete.
        try {
          await api.listStreams(restored.apiBaseUrl, restored.token);
          setSession(restored);
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) {
            await clearSession().catch(() => {});
          }
          // Otherwise: leave the stored session alone and just don't log in
          // automatically this time: the user can retry, and a successful
          // login later will only ever happen via the actual login form.
        }
      })
      .finally(() => setRestoring(false));
  }, []);

  async function handleLogin(newSession: Session) {
    setSession(newSession);
    await saveSession(newSession).catch(() => {});
  }

  async function handleSignOut() {
    await api.logout(session!.apiBaseUrl, session!.token).catch(() => {});
    await clearSession().catch(() => {});
    setSession(undefined);
    setView("host");
  }

  if (restoring) {
    return <div className="flex h-screen items-center justify-center bg-neutral-950 text-neutral-100">Loading…</div>;
  }

  if (!session) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-6 py-3">
        <div>
          <h1 className="text-base font-semibold">Ayran LAN Streamer</h1>
          <p className="text-xs text-neutral-400">{session.account.email}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded border border-neutral-700 text-sm">
            <button
              className={`px-3 py-1 ${view === "host" ? "bg-blue-600" : "hover:bg-neutral-800"}`}
              onClick={() => setView("host")}
            >
              Host
            </button>
            <button
              className={`px-3 py-1 ${view === "listener" ? "bg-blue-600" : "hover:bg-neutral-800"}`}
              onClick={() => setView("listener")}
            >
              Listen
            </button>
          </div>
          <button className="rounded border border-neutral-700 px-3 py-1 text-sm hover:bg-neutral-800" onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      </header>

      <main className="p-6">
        {/* Both panels stay mounted regardless of which tab is showing -
            switching tabs only changes visibility (CSS), not whether
            hosting/listening is actually running. */}
        <div className={view === "host" ? "" : "hidden"}>
          <HostPanel session={session} />
        </div>
        <div className={view === "listener" ? "" : "hidden"}>
          <ListenerPanel session={session} />
        </div>
      </main>
    </div>
  );
}
