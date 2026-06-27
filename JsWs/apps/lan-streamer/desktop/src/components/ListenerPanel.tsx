import { useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { AudioPlayback } from "../lib/audioPlayback";
import { activeHostsSummary, connectionStatusLabel } from "../lib/format";
import { connectWithBackoff, type ConnectionStatus, type ReconnectingSocket } from "../lib/reconnectingSocket";
import type { Session, StreamRecord } from "../lib/types";
import { MaxAmplitudeControl } from "./MaxAmplitudeControl";

const REFRESH_INTERVAL_MS = 4000;
const EXPECTED_FRAME_INTERVAL_MS = 20;

interface MultiListenSession {
  socket: ReconnectingSocket;
  playback: AudioPlayback;
}

export function ListenerPanel({ session }: { session: Session }) {
  const [streams, setStreams] = useState<StreamRecord[]>([]);
  const [listeningStreamId, setListeningStreamId] = useState<string>();
  const [error, setError] = useState<string>();
  const [connectionStatus, setConnectionStatus] = useState<{ status: ConnectionStatus; attempt: number }>();

  const socketRef = useRef<ReconnectingSocket | undefined>(undefined);
  const playbackRef = useRef<AudioPlayback | undefined>(undefined);

  // Multi-listen ("mix locally") mode is a deliberately separate mechanism
  // from the single-stream one above, only ever touched when the checkbox
  // is checked - the existing single-stream state/functions are untouched
  // so that unchecked behavior is exactly what it always was. "Mixing" here
  // just means playing multiple independent streams at once, each through
  // its own AudioPlayback/AudioContext - the OS/Web Audio output naturally
  // sums everything routed to the same audio device, so no extra PCM-level
  // mixing code is needed to get the audible result of multiple streams
  // playing together.
  const [multiListenEnabled, setMultiListenEnabled] = useState(false);
  const [multiListeningIds, setMultiListeningIds] = useState<Set<string>>(new Set());
  const [multiConnectionStatus, setMultiConnectionStatus] = useState<Map<string, { status: ConnectionStatus; attempt: number }>>(
    new Map(),
  );
  const multiSessionsRef = useRef<Map<string, MultiListenSession>>(new Map());

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
      stopListening();
      stopAllMultiListening();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startListening(streamId: string) {
    stopListening();
    setError(undefined);

    const playback = new AudioPlayback();
    let lastReceivedAt: number | undefined;
    // Diagnostics: a ~8-13% audio buffer deficit was measured on the
    // playback side despite every *timing* diagnostic (WS receive gaps,
    // main-thread relay, audio-thread delivery) coming back clean. A gap
    // diagnostic can only catch delay, not loss - if messages are being
    // silently dropped without delaying the *next* one's arrival, gap
    // checks would never see it. This counts actual message throughput
    // against the expected rate to check for loss directly.
    let messageCount = 0;
    let throughputWindowStart: number | undefined;
    const socket = connectWithBackoff(
      () => api.wsUrl(session.apiBaseUrl, "listen", streamId, session.token),
      {
        onMessage: (event) => {
          // Diagnostics: each frame is 20ms of audio. A gap much larger than
          // that between WebSocket messages arriving means the network path
          // from the API to this device is the one introducing the delay -
          // by elimination, after the host-side capture/IPC/send path was
          // already confirmed to be on time.
          const now = performance.now();
          if (lastReceivedAt !== undefined) {
            const gap = now - lastReceivedAt;
            if (gap > EXPECTED_FRAME_INTERVAL_MS * 3) {
              console.warn(
                `[ListenerPanel] frame receive gap: ${gap.toFixed(1)}ms since previous frame (expected ~${EXPECTED_FRAME_INTERVAL_MS}ms) - network delay to this device`,
              );
            }
          }
          lastReceivedAt = now;

          if (throughputWindowStart === undefined) throughputWindowStart = now;
          messageCount += 1;
          const windowElapsed = now - throughputWindowStart;
          if (windowElapsed >= 2000) {
            const expectedCount = Math.round(windowElapsed / EXPECTED_FRAME_INTERVAL_MS);
            const lossPct = (100 * (expectedCount - messageCount)) / expectedCount;
            console.log(
              `[ListenerPanel] throughput: received ${messageCount} frames in ${windowElapsed.toFixed(0)}ms (expected ~${expectedCount}) - ${lossPct.toFixed(1)}% loss`,
            );
            messageCount = 0;
            throughputWindowStart = now;
          }

          playback.enqueueFrame(event.data as ArrayBuffer);
        },
        onStatusChange: (status, attempt) => {
          // Diagnostics: confirms (or refutes) whether the large, infrequent
          // gaps seen are WebSocket reconnect cycles rather than ordinary
          // network jitter on an otherwise-stable connection.
          console.warn(`[ListenerPanel] connection status: ${status}${attempt ? ` (attempt ${attempt})` : ""}`);
          setConnectionStatus({ status, attempt });
        },
      },
    );

    socketRef.current = socket;
    playbackRef.current = playback;
    setListeningStreamId(streamId);
  }

  function stopListening() {
    socketRef.current?.close();
    socketRef.current = undefined;
    playbackRef.current?.stop();
    playbackRef.current = undefined;
    setListeningStreamId(undefined);
    setConnectionStatus(undefined);
  }

  function startMultiListening(streamId: string) {
    if (multiSessionsRef.current.has(streamId)) return;

    const playback = new AudioPlayback();
    const socket = connectWithBackoff(() => api.wsUrl(session.apiBaseUrl, "listen", streamId, session.token), {
      onMessage: (event) => playback.enqueueFrame(event.data as ArrayBuffer),
      onStatusChange: (status, attempt) => {
        setMultiConnectionStatus((prev) => new Map(prev).set(streamId, { status, attempt }));
      },
    });

    multiSessionsRef.current.set(streamId, { socket, playback });
    setMultiListeningIds((prev) => new Set(prev).add(streamId));
  }

  function stopMultiListening(streamId: string) {
    const sessionToStop = multiSessionsRef.current.get(streamId);
    if (!sessionToStop) return;
    sessionToStop.socket.close();
    sessionToStop.playback.stop();
    multiSessionsRef.current.delete(streamId);
    setMultiListeningIds((prev) => {
      const next = new Set(prev);
      next.delete(streamId);
      return next;
    });
    setMultiConnectionStatus((prev) => {
      const next = new Map(prev);
      next.delete(streamId);
      return next;
    });
  }

  function stopAllMultiListening() {
    for (const streamId of [...multiSessionsRef.current.keys()]) stopMultiListening(streamId);
  }

  function handleMultiListenToggle(enabled: boolean) {
    // Switching modes tears down whatever's active in the *other* mode -
    // avoids ever having both a single-mode and a multi-mode session
    // pointed at conflicting state at once.
    if (enabled) stopListening();
    else stopAllMultiListening();
    setMultiListenEnabled(enabled);
  }

  return (
    <div className="space-y-4">
      <MaxAmplitudeControl session={session} />

      <label className="flex items-center gap-2 text-sm text-neutral-300">
        <input type="checkbox" checked={multiListenEnabled} onChange={(e) => handleMultiListenToggle(e.target.checked)} />
        Listen to multiple streams at once (mixed locally)
      </label>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <ul className="space-y-2">
        {streams.map((stream) => {
          if (multiListenEnabled) {
            const isListening = multiListeningIds.has(stream.id);
            const status = multiConnectionStatus.get(stream.id);
            return (
              <li key={stream.id} className="flex items-center justify-between rounded border border-neutral-800 px-3 py-2">
                <div>
                  <p className="font-medium">{stream.name}</p>
                  <p className="text-xs text-neutral-400">
                    {activeHostsSummary(stream.activeHosts)}
                    {isListening && status && status.status !== "open" && (
                      <span className="ml-2 text-amber-400">{connectionStatusLabel(status.status, status.attempt)}</span>
                    )}
                  </p>
                </div>
                {isListening ? (
                  <button
                    className="rounded bg-neutral-700 px-2 py-1 text-sm hover:bg-neutral-600"
                    onClick={() => stopMultiListening(stream.id)}
                  >
                    Stop
                  </button>
                ) : (
                  <button
                    className="rounded bg-green-600 px-2 py-1 text-sm hover:bg-green-500"
                    onClick={() => startMultiListening(stream.id)}
                  >
                    Listen
                  </button>
                )}
              </li>
            );
          }

          const isListening = listeningStreamId === stream.id;
          return (
            <li key={stream.id} className="flex items-center justify-between rounded border border-neutral-800 px-3 py-2">
              <div>
                <p className="font-medium">{stream.name}</p>
                <p className="text-xs text-neutral-400">
                  {activeHostsSummary(stream.activeHosts)}
                  {isListening && connectionStatus && connectionStatus.status !== "open" && (
                    <span className="ml-2 text-amber-400">
                      {connectionStatusLabel(connectionStatus.status, connectionStatus.attempt)}
                    </span>
                  )}
                </p>
              </div>
              {isListening ? (
                <button className="rounded bg-neutral-700 px-2 py-1 text-sm hover:bg-neutral-600" onClick={stopListening}>
                  Stop
                </button>
              ) : (
                <button
                  className="rounded bg-green-600 px-2 py-1 text-sm hover:bg-green-500 disabled:opacity-50"
                  disabled={!!listeningStreamId}
                  onClick={() => startListening(stream.id)}
                >
                  Listen
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
