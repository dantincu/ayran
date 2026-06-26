import { useState } from "react";
import { login } from "../lib/api";
import { DEFAULT_API_BASE_URL } from "../lib/config";
import type { Session } from "../lib/types";

export function LoginScreen({ onLogin }: { onLogin: (session: Session) => void }) {
  const [apiBaseUrl, setApiBaseUrl] = useState(localStorage.getItem("lan-streamer:apiBaseUrl") ?? DEFAULT_API_BASE_URL);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  function handleApiBaseUrlChange(value: string) {
    setApiBaseUrl(value);
    // Persist as the user types, not just on successful login, so a typed
    // URL isn't lost if they close the app before logging in successfully.
    localStorage.setItem("lan-streamer:apiBaseUrl", value);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const { token, account } = await login(apiBaseUrl, email, password, twoFactorCode || undefined);
      onLogin({ apiBaseUrl, token, account });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-neutral-950 text-neutral-100">
      <form onSubmit={handleSubmit} className="w-80 space-y-3 rounded-lg border border-neutral-800 bg-neutral-900 p-6">
        <h1 className="text-lg font-semibold">Ayran LAN Streamer</h1>
        <p className="text-sm text-neutral-400">Sign in with your Filen.io account</p>

        <label className="block text-sm">
          API server URL
          <input
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-800 px-2 py-1"
            value={apiBaseUrl}
            onChange={(e) => handleApiBaseUrlChange(e.target.value)}
          />
        </label>

        <label className="block text-sm">
          Filen email
          <input
            type="email"
            required
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-800 px-2 py-1"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>

        <label className="block text-sm">
          Filen password
          <input
            type="password"
            required
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-800 px-2 py-1"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        <label className="block text-sm">
          2FA code (if enabled)
          <input
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-800 px-2 py-1"
            value={twoFactorCode}
            onChange={(e) => setTwoFactorCode(e.target.value)}
          />
        </label>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-blue-600 py-2 font-medium hover:bg-blue-500 disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
