import { useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { AudioCapture, captureStream, type AudioSource } from "../lib/audioCapture";
import { activeHostsSummary, connectionStatusLabel } from "../lib/format";
import { startForegroundService, stopForegroundService } from "../lib/foregroundService";
import { MaxAmplitudeControl } from "./MaxAmplitudeControl";
import { connectWithBackoff, type ConnectionStatus, type ReconnectingSocket } from "../lib/reconnectingSocket";
import type { Session, StreamMode, StreamRecord } from "../lib/types";

const REFRESH_INTERVAL_MS = 4000;
const GAIN_STORAGE_KEY = "lan-streamer:deviceGain";

function loadStoredGain(): number {
  const raw = localStorage.getItem(GAIN_STORAGE_KEY);
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 1;
}

export function HostPanel({ session }: { session: Session }) {
  const [streams, setStreams] = useState<StreamRecord[]>([]);
  const [newStreamName, setNewStreamName] = useState("");
  const [newStreamMode, setNewStreamMode] = useState<StreamMode>("merged");
  const [error, setError] = useState<string>();
  const [audioSource, setAudioSource] = useState<AudioSource>("microphone");
  const [hostingStreamId, setHostingStreamId] = useState<string>();
  const [paused, setPaused] = useState(false);
  // Persisted per-device, not per-account: this is "how loud THIS device's
  // contribution is," a local hardware/placement preference, not something
  // that should follow the user to a different device.
  const [gain, setGain] = useState(loadStoredGain);
  const [connectionStatus, setConnectionStatus] = useState<{ status: ConnectionStatus; attempt: number }>();

  const socketRef = useRef<ReconnectingSocket | undefined>(undefined);
  const captureRef = useRef<AudioCapture | undefined>(undefined);
  const mediaStreamRef = useRef<MediaStream | undefined>(undefined);
  const pausedRef = useRef(false);

  const isHostingRaw = hostingStreamId !== undefined && streams.find((s) => s.id === hostingStreamId)?.mode === "raw";

  async function refresh() {
    try {
      setStreams(await api.listStreams(session.apiBaseUrl, session.token));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load streams");
    }
  }

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      clearInterval(interval);
      stopHosting();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newStreamName.trim()) return;
    try {
      await api.createStream(session.apiBaseUrl, session.token, newStreamName.trim(), newStreamMode);
      setNewStreamName("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create stream");
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.deleteStream(session.apiBaseUrl, session.token, id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete stream");
    }
  }

  async function startHosting(streamId: string) {
    setError(undefined);
    try {
      // Raw streams bypass the device's own volume slider too, not just the
      // account-wide cap - "forwarded raw" means the actual captured signal,
      // unmodified by anything on either end, so this device's gain control
      // simply doesn't apply while hosting one.
      const isRaw = streams.find((s) => s.id === streamId)?.mode === "raw";
      const effectiveGain = isRaw ? 1 : gain;

      // The connection and the capture pipeline are independent: a dropped
      // WebSocket reconnects with backoff in the background while capture
      // keeps running, rather than tearing down hosting on a network blip.
      const socket = connectWithBackoff(() => api.wsUrl(session.apiBaseUrl, "host", streamId, session.token, audioSource), {
        onStatusChange: (status, attempt) => setConnectionStatus({ status, attempt }),
        onMessage: (event) => {
          // Simple streams only allow one active host at a time - the server
          // sends this control message (as text, not a binary audio frame)
          // when another device has just taken over this stream.
          if (typeof event.data !== "string") return;
          try {
            const message = JSON.parse(event.data);
            if (message.type === "superseded") {
              setError("Another device started streaming on this stream, so this device stopped.");
              stopHosting();
            }
          } catch {
            // Not a JSON control message - ignore.
          }
        },
      });
      socketRef.current = socket;

      // Capture first, start the foreground service after: requesting the
      // Android "microphone" foreground-service-type before RECORD_AUDIO is
      // actually granted throws a SecurityException and crashes the app -
      // captureStream() succeeding is what proves the mic permission (if
      // this source needs it) has already been granted.
      const mediaStream = await captureStream(audioSource);
      // "test-tone" is just a marker passed straight through to
      // AudioCapture (which generates that audio internally) - there's no
      // real MediaStream/tracks to stop for it.
      mediaStreamRef.current = mediaStream === "test-tone" ? undefined : mediaStream;
      void startForegroundService(audioSource === "microphone" ? "hosting-microphone" : "hosting-test-tone");
      captureRef.current = new AudioCapture(
        mediaStream,
        (frame) => {
          if (!pausedRef.current) socket.send(frame.buffer);
        },
        effectiveGain,
      );

      pausedRef.current = false;
      setPaused(false);
      setHostingStreamId(streamId);
      // The server only registers this connection once the WebSocket finishes
      // opening, slightly after this point - nudge a refresh shortly after so
      // the count/source breakdown updates without waiting for the next poll.
      setTimeout(() => void refresh(), 500);
    } catch (err) {
      // Diagnostic: the UI only shows err.message ("Permission denied"),
      // which is ambiguous between several distinct getUserMedia failure
      // modes (DOMException.name disambiguates: NotAllowedError vs
      // NotFoundError vs NotReadableError vs SecurityException etc.).
      console.error("[HostPanel] startHosting failed:", err, (err as { name?: string } | undefined)?.name);
      setError(err instanceof Error ? err.message : "Failed to start hosting");
      stopHosting();
    }
  }

  function stopHosting() {
    captureRef.current?.stop();
    captureRef.current = undefined;
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = undefined;
    socketRef.current?.close();
    socketRef.current = undefined;
    void stopForegroundService();
    setHostingStreamId(undefined);
    setConnectionStatus(undefined);
    setPaused(false);
    pausedRef.current = false;
    setTimeout(() => void refresh(), 500);
  }

  async function togglePause(streamId: string) {
    const next = !paused;
    pausedRef.current = next;
    setPaused(next);
    if (next) await api.pauseStream(session.apiBaseUrl, session.token, streamId);
    else await api.resumeStream(session.apiBaseUrl, session.token, streamId);
  }

  function handleGainChange(next: number) {
    setGain(next);
    localStorage.setItem(GAIN_STORAGE_KEY, String(next));
    // Raw hosting locks the live gain at 1 regardless of the slider (see
    // startHosting) - the slider UI is disabled in that case, but guard here
    // too rather than relying solely on the disabled attribute.
    if (isHostingRaw) return;
    captureRef.current?.setGain(next);
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleCreate} className="space-y-2">
        <div className="flex gap-2">
          <input
            className="flex-1 rounded border border-neutral-700 bg-neutral-800 px-2 py-1"
            placeholder="New stream name"
            value={newStreamName}
            onChange={(e) => setNewStreamName(e.target.value)}
          />
          <button className="rounded bg-blue-600 px-3 py-1 hover:bg-blue-500" type="submit">
            Create
          </button>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <label className="flex items-center gap-1">
            <input type="radio" checked={newStreamMode === "merged"} onChange={() => setNewStreamMode("merged")} />
            Merged (multiple devices mixed together)
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" checked={newStreamMode === "simple"} onChange={() => setNewStreamMode("simple")} />
            Simple (one device forwarded directly, no mixing)
          </label>
          <label className="flex items-center gap-1" title="No mixing, and no volume cap or limiter either - bytes forwarded exactly as received">
            <input type="radio" checked={newStreamMode === "raw"} onChange={() => setNewStreamMode("raw")} />
            Raw (one device, unprocessed, no volume cap)
          </label>
        </div>
      </form>

      <div className="flex items-center gap-3 text-sm">
        <span>Audio source:</span>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            checked={audioSource === "microphone"}
            disabled={!!hostingStreamId}
            onChange={() => setAudioSource("microphone")}
          />
          Microphone
        </label>
        <label className="flex items-center gap-1 text-neutral-500" title="Desktop-only — see README">
          <input type="radio" checked={false} disabled />
          System / speaker output (desktop-only, see README)
        </label>
        <label className="flex items-center gap-1" title="Plays a bundled quiet/loud/quiet test signal on a loop - useful for testing the pipeline and the account-wide volume cap without a mic or speakers">
          <input
            type="radio"
            checked={audioSource === "test-tone"}
            disabled={!!hostingStreamId}
            onChange={() => setAudioSource("test-tone")}
          />
          App's test sound
        </label>
      </div>

      <div className="rounded border border-neutral-800 px-3 py-2 text-sm">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="device-gain" className="text-neutral-300">
            This device's volume
          </label>
          <span className="tabular-nums text-neutral-400">{isHostingRaw ? "100% (raw)" : `${Math.round(gain * 100)}%`}</span>
        </div>
        <input
          id="device-gain"
          type="range"
          min={0}
          max={100}
          value={isHostingRaw ? 100 : Math.round(gain * 100)}
          disabled={isHostingRaw}
          title={isHostingRaw ? "Raw streams bypass this device's volume control - the signal is forwarded unmodified" : undefined}
          onChange={(e) => handleGainChange(Number(e.target.value) / 100)}
          className="mt-1 w-full disabled:opacity-50"
        />
      </div>

      <MaxAmplitudeControl session={session} />

      {error && <p className="text-sm text-red-400">{error}</p>}

      <ul className="space-y-2">
        {streams.map((stream) => {
          const isHosting = hostingStreamId === stream.id;
          return (
            <li key={stream.id} className="flex items-center justify-between rounded border border-neutral-800 px-3 py-2">
              <div>
                <p className="font-medium">
                  {stream.name}{" "}
                  <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-xs font-normal text-neutral-400">
                    {stream.mode === "simple" ? "Simple" : stream.mode === "raw" ? "Raw" : "Merged"}
                  </span>
                </p>
                <p className="text-xs text-neutral-400">
                  {activeHostsSummary(stream.activeHosts)}
                  {isHosting && connectionStatus && connectionStatus.status !== "open" && (
                    <span className="ml-2 text-amber-400">
                      {connectionStatusLabel(connectionStatus.status, connectionStatus.attempt)}
                    </span>
                  )}
                </p>
              </div>
              <div className="flex gap-2">
                {isHosting ? (
                  <>
                    <button
                      className="rounded bg-amber-600 px-2 py-1 text-sm hover:bg-amber-500"
                      onClick={() => togglePause(stream.id)}
                    >
                      {paused ? "Resume" : "Pause"}
                    </button>
                    <button className="rounded bg-neutral-700 px-2 py-1 text-sm hover:bg-neutral-600" onClick={stopHosting}>
                      Stop
                    </button>
                  </>
                ) : (
                  <button
                    className="rounded bg-green-600 px-2 py-1 text-sm hover:bg-green-500 disabled:opacity-50"
                    disabled={!!hostingStreamId}
                    onClick={() => startHosting(stream.id)}
                  >
                    Host
                  </button>
                )}
                <button
                  className="rounded bg-red-700 px-2 py-1 text-sm hover:bg-red-600 disabled:opacity-50"
                  disabled={isHosting}
                  onClick={() => handleDelete(stream.id)}
                >
                  Delete
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
