import { useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { AudioPlayback } from "../lib/audioPlayback";
import { connectWithBackoff, type ConnectionStatus, type ReconnectingSocket } from "../lib/reconnectingSocket";
import type { Session, StreamRecord } from "../lib/types";

function connectionStatusLabel(status: ConnectionStatus, attempt: number): string {
  switch (status) {
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return `Reconnecting… (attempt ${attempt})`;
    case "closed":
      return "Disconnected";
    case "open":
      return "Connected";
  }
}

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
    return () => stopListening();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startListening(streamId: string) {
    stopListening();
    setError(undefined);

    const playback = new AudioPlayback();
    const socket = connectWithBackoff(
      () => api.wsUrl(session.apiBaseUrl, "listen", streamId, session.token),
      {
        onMessage: (event) => playback.enqueueFrame(event.data as ArrayBuffer),
        onStatusChange: (status, attempt) => setConnectionStatus({ status, attempt }),
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

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-400">{error}</p>}

      <ul className="space-y-2">
        {streams.map((stream) => {
          const isListening = listeningStreamId === stream.id;
          return (
            <li key={stream.id} className="flex items-center justify-between rounded border border-neutral-800 px-3 py-2">
              <div>
                <p className="font-medium">{stream.name}</p>
                <p className="text-xs text-neutral-400">
                  {stream.activeHostAccountIds.length} active host(s)
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
