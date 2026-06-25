import { useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { AudioPlayback } from "../lib/audioPlayback";
import type { Session, StreamRecord } from "../lib/types";

export function ListenerPanel({ session }: { session: Session }) {
  const [streams, setStreams] = useState<StreamRecord[]>([]);
  const [listeningStreamId, setListeningStreamId] = useState<string>();
  const [error, setError] = useState<string>();

  const wsRef = useRef<WebSocket | undefined>(undefined);
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

    const ws = new WebSocket(api.wsUrl(session.apiBaseUrl, "listen", streamId, session.token));
    ws.binaryType = "arraybuffer";
    const playback = new AudioPlayback();

    ws.onmessage = (event) => playback.enqueueFrame(event.data as ArrayBuffer);
    ws.onclose = () => stopListening();
    ws.onerror = () => setError("Listening connection failed");

    wsRef.current = ws;
    playbackRef.current = playback;
    setListeningStreamId(streamId);
  }

  function stopListening() {
    wsRef.current?.close();
    wsRef.current = undefined;
    playbackRef.current?.stop();
    playbackRef.current = undefined;
    setListeningStreamId(undefined);
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
                <p className="text-xs text-neutral-400">{stream.activeHostAccountIds.length} active host(s)</p>
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
