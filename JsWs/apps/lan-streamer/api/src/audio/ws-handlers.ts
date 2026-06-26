import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { accountForToken } from "../auth.js";
import { addActiveHost, getStream, removeActiveHost } from "../store.js";
import type { HostAudioSource } from "../types.js";
import {
  BYTES_PER_FRAME,
  forwardSimpleFrame,
  pushHostFrame,
  registerHost,
  registerListener,
  registerSimpleListener,
  unregisterHost,
  unregisterListener,
  unregisterSimpleListener,
} from "./mixer.js";

const wss = new WebSocketServer({ noServer: true });

// Tracks which host connection is currently "live" on each simple stream -
// a second host starting up supersedes whoever's currently in this map for
// that streamId, rather than mixing with them.
const activeSimpleHosts = new Map<string, { connectionId: string; ws: WebSocket }>();

function closeWith(socket: Duplex, code: number, reason: string): void {
  socket.end(`HTTP/1.1 ${code} ${reason}\r\n\r\n`);
}

export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(req.url ?? "", "http://localhost");
  const [, , kind, streamId] = url.pathname.split("/"); // /ws/host/:id or /ws/listen/:id
  const token = url.searchParams.get("token") ?? undefined;

  const account = accountForToken(token);
  if (!account) {
    closeWith(socket, 401, "Unauthorized");
    return;
  }

  const stream = streamId ? getStream(streamId) : undefined;
  if (!stream) {
    closeWith(socket, 404, "Not Found");
    return;
  }

  if (kind === "host") {
    if (stream.ownerAccountId !== account.userId) {
      closeWith(socket, 403, "Forbidden");
      return;
    }
    // An account can host any number of distinct streams at once (each from a
    // different device/window "device stream"); only a single connection is
    // ever tied to one streamId, since that's inherent to one WebSocket.
    const sourceParam = url.searchParams.get("source");
    const audioSource: HostAudioSource =
      sourceParam === "system" || sourceParam === "test-tone" ? sourceParam : "microphone";
    wss.handleUpgrade(req, socket, head, (ws) =>
      stream.mode === "simple"
        ? attachSimpleHost(ws, streamId, account.userId, audioSource)
        : attachHost(ws, streamId, account.userId, audioSource),
    );
    return;
  }

  if (kind === "listen") {
    wss.handleUpgrade(req, socket, head, (ws) =>
      stream.mode === "simple" ? attachSimpleListener(ws, streamId) : attachListener(ws, streamId),
    );
    return;
  }

  closeWith(socket, 404, "Not Found");
}

function attachHost(ws: WebSocket, streamId: string, accountId: number, audioSource: HostAudioSource): void {
  const connectionId = randomUUID();

  registerHost(streamId, connectionId, accountId);
  addActiveHost(streamId, connectionId, accountId, audioSource);

  ws.on("message", (data, isBinary) => {
    if (!isBinary) return;
    const frame = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (frame.length !== BYTES_PER_FRAME) return;
    pushHostFrame(streamId, connectionId, frame);
  });

  ws.on("close", () => {
    unregisterHost(streamId, connectionId);
    removeActiveHost(streamId, connectionId, accountId);
  });
}

function attachListener(ws: WebSocket, streamId: string): void {
  registerListener(streamId, ws);
  ws.on("close", () => unregisterListener(streamId, ws));
}

function attachSimpleHost(ws: WebSocket, streamId: string, accountId: number, audioSource: HostAudioSource): void {
  const connectionId = randomUUID();

  // A second host starting up on the same simple stream supersedes whoever
  // was streaming on it - tell that previous connection why it's being cut
  // off (rather than leaving it to guess from a plain close) and disconnect
  // it, instead of letting two sources collide.
  const previous = activeSimpleHosts.get(streamId);
  if (previous && previous.connectionId !== connectionId) {
    if (previous.ws.readyState === previous.ws.OPEN) {
      previous.ws.send(JSON.stringify({ type: "superseded" }));
    }
    previous.ws.close();
  }
  activeSimpleHosts.set(streamId, { connectionId, ws });

  addActiveHost(streamId, connectionId, accountId, audioSource);

  ws.on("message", (data, isBinary) => {
    if (!isBinary) return;
    // Ignore frames from a connection that's since been superseded but
    // hasn't finished closing yet - only the current active host forwards.
    if (activeSimpleHosts.get(streamId)?.connectionId !== connectionId) return;
    const frame = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (frame.length !== BYTES_PER_FRAME) return;
    forwardSimpleFrame(streamId, accountId, frame);
  });

  ws.on("close", () => {
    if (activeSimpleHosts.get(streamId)?.connectionId === connectionId) {
      activeSimpleHosts.delete(streamId);
    }
    removeActiveHost(streamId, connectionId, accountId);
  });
}

function attachSimpleListener(ws: WebSocket, streamId: string): void {
  registerSimpleListener(streamId, ws);
  ws.on("close", () => unregisterSimpleListener(streamId, ws));
}
