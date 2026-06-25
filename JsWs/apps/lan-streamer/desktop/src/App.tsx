import { useState } from "react";
import { LoginScreen } from "./components/LoginScreen";
import { HostPanel } from "./components/HostPanel";
import { ListenerPanel } from "./components/ListenerPanel";
import * as api from "./lib/api";
import type { Session } from "./lib/types";

type Role = "host" | "listener";

export default function App() {
  const [session, setSession] = useState<Session>();
  const [role, setRole] = useState<Role>();

  if (!session) {
    return <LoginScreen onLogin={setSession} />;
  }

  async function handleSignOut() {
    await api.logout(session!.apiBaseUrl, session!.token).catch(() => {});
    setSession(undefined);
    setRole(undefined);
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
              className={`px-3 py-1 ${role === "host" ? "bg-blue-600" : "hover:bg-neutral-800"}`}
              onClick={() => setRole("host")}
            >
              Host
            </button>
            <button
              className={`px-3 py-1 ${role === "listener" ? "bg-blue-600" : "hover:bg-neutral-800"}`}
              onClick={() => setRole("listener")}
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
        {role === "host" && <HostPanel session={session} />}
        {role === "listener" && <ListenerPanel session={session} />}
        {!role && <p className="text-neutral-400">Choose whether to host a stream or listen to one.</p>}
      </main>
    </div>
  );
}
