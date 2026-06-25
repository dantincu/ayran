import { useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { AudioCapture, captureStream, type AudioSource } from "../lib/audioCapture";
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

export function HostPanel({ session }: { session: Session }) {
  const [streams, setStreams] = useState<StreamRecord[]>([]);
  const [newStreamName, setNewStreamName] = useState("");
  const [error, setError] = useState<string>();
  const [audioSource, setAudioSource] = useState<AudioSource>("microphone");
  const [hostingStreamId, setHostingStreamId] = useState<string>();
  const [paused, setPaused] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<{ status: ConnectionStatus; attempt: number }>();

  const socketRef = useRef<ReconnectingSocket | undefined>(undefined);
  const captureRef = useRef<AudioCapture | undefined>(undefined);
  const mediaStreamRef = useRef<MediaStream | undefined>(undefined);
  const pausedRef = useRef(false);

  async function refresh() {
    try {
      setStreams(await api.listStreams(session.apiBaseUrl, session.token));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load streams");
    }
  }

  useEffect(() => {
    void refresh();
    return () => stopHosting();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newStreamName.trim()) return;
    try {
      await api.createStream(session.apiBaseUrl, session.token, newStreamName.trim());
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
      // The connection and the capture pipeline are independent: a dropped
      // WebSocket reconnects with backoff in the background while capture
      // keeps running, rather than tearing down hosting on a network blip.
      const socket = connectWithBackoff(
        () => api.wsUrl(session.apiBaseUrl, "host", streamId, session.token),
        { onStatusChange: (status, attempt) => setConnectionStatus({ status, attempt }) },
      );
      socketRef.current = socket;

      const mediaStream = await captureStream(audioSource);
      mediaStreamRef.current = mediaStream;
      captureRef.current = new AudioCapture(mediaStream, (frame) => {
        if (!pausedRef.current) socket.send(frame.buffer);
      });

      pausedRef.current = false;
      setPaused(false);
      setHostingStreamId(streamId);
    } catch (err) {
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
    setHostingStreamId(undefined);
    setConnectionStatus(undefined);
    setPaused(false);
    pausedRef.current = false;
  }

  async function togglePause(streamId: string) {
    const next = !paused;
    pausedRef.current = next;
    setPaused(next);
    if (next) await api.pauseStream(session.apiBaseUrl, session.token, streamId);
    else await api.resumeStream(session.apiBaseUrl, session.token, streamId);
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleCreate} className="flex gap-2">
        <input
          className="flex-1 rounded border border-neutral-700 bg-neutral-800 px-2 py-1"
          placeholder="New stream name"
          value={newStreamName}
          onChange={(e) => setNewStreamName(e.target.value)}
        />
        <button className="rounded bg-blue-600 px-3 py-1 hover:bg-blue-500" type="submit">
          Create
        </button>
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
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <ul className="space-y-2">
        {streams.map((stream) => {
          const isHosting = hostingStreamId === stream.id;
          return (
            <li key={stream.id} className="flex items-center justify-between rounded border border-neutral-800 px-3 py-2">
              <div>
                <p className="font-medium">{stream.name}</p>
                <p className="text-xs text-neutral-400">
                  {stream.activeHostAccountIds.length} active host(s)
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
