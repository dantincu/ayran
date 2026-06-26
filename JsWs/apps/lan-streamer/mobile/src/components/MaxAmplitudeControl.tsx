import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { Session } from "../lib/types";

/**
 * Account-wide safety cap: the API limits each device stream's peak
 * amplitude to this fraction of full scale before mixing it with others
 * (see api/src/audio/mixer.ts). Editable from either the host or listener
 * screen since it's a per-account setting, not tied to a specific stream.
 */
export function MaxAmplitudeControl({ session }: { session: Session }) {
  const [value, setValue] = useState<number>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    api
      .getAccountSettings(session.apiBaseUrl, session.token)
      .then((settings) => setValue(settings.maxDeviceAmplitude))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load settings"));
  }, [session.apiBaseUrl, session.token]);

  async function handleChange(next: number) {
    setValue(next);
    setSaving(true);
    setError(undefined);
    try {
      await api.updateAccountSettings(session.apiBaseUrl, session.token, { maxDeviceAmplitude: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  if (value === undefined) return null;

  return (
    <div className="rounded border border-neutral-800 px-3 py-2 text-sm">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="max-amplitude" className="text-neutral-300">
          Max device stream volume{" "}
          <span className="text-neutral-500" title="Safety cap applied to every device stream before mixing, to protect against sudden loud transients. Lower = more headroom.">
            (account-wide)
          </span>
        </label>
        <span className="tabular-nums text-neutral-400">{Math.round(value * 100)}%</span>
      </div>
      <input
        id="max-amplitude"
        type="range"
        min={10}
        max={100}
        value={Math.round(value * 100)}
        onChange={(e) => handleChange(Number(e.target.value) / 100)}
        className="mt-1 w-full"
      />
      {saving && <p className="text-xs text-neutral-500">Saving…</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
