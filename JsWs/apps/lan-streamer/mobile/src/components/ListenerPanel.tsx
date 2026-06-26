import { useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { AudioPlayback } from "../lib/audioPlayback";
import { activeHostsSummary, connectionStatusLabel } from "../lib/format";
import { startForegroundService, stopForegroundService } from "../lib/foregroundService";
import { connectWithBackoff, type ConnectionStatus, type ReconnectingSocket } from "../lib/reconnectingSocket";
import type { Session, StreamRecord } from "../lib/types";
import { MaxAmplitudeControl } from "./MaxAmplitudeControl";

const REFRESH_INTERVAL_MS = 4000;
const EXPECTED_FRAME_INTERVAL_MS = 20;

export function ListenerPanel({ session }: { session: Session }) {
  const [streams, setStreams] = useState<StreamRecord[]>([]);
  const [listeningStreamId, setListeningStreamId] = useState<string>();
  const [error, setError] = useState<string>();
  const [connectionStatus, setConnectionStatus] = useState<{ status: ConnectionStatus; attempt: number }>();

  const socketRef = useRef<ReconnectingSocket | undefined>(undefined);
  const playbackRef = useRef<AudioPlayback | undefined>(undefined);

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
    void startForegroundService("listening");
    setListeningStreamId(streamId);
  }

  function stopListening() {
    socketRef.current?.close();
    socketRef.current = undefined;
    playbackRef.current?.stop();
    playbackRef.current = undefined;
    void stopForegroundService();
    setListeningStreamId(undefined);
    setConnectionStatus(undefined);
  }

  return (
    <div className="space-y-4">
      <MaxAmplitudeControl session={session} />

      {error && <p className="text-sm text-red-400">{error}</p>}

      <ul className="space-y-2">
        {streams.map((stream) => {
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
