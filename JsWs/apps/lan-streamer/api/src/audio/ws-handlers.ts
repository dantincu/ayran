import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { accountForToken } from "../auth.js";
import { addActiveHost, getStream, removeActiveHost } from "../store.js";
import type { HostAudioSource } from "../types.js";
import {
  BYTES_PER_FRAME,
  forwardRawFrame,
  forwardSimpleFrame,
  pushHostFrame,
  registerHost,
  registerListener,
  registerRawListener,
  registerSimpleListener,
  unregisterHost,
  unregisterListener,
  unregisterRawListener,
  unregisterSimpleListener,
} from "./mixer.js";

const wss = new WebSocketServer({ noServer: true });

// Tracks which host connection is currently "live" on each simple/raw stream
// - a second host starting up supersedes whoever's currently in the map for
// that streamId, rather than mixing with them. Separate maps per mode since
// "simple" and "raw" are otherwise-independent stream namespaces.
const activeSimpleHosts = new Map<string, { connectionId: string; ws: WebSocket }>();
const activeRawHosts = new Map<string, { connectionId: string; ws: WebSocket }>();

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
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (stream.mode === "simple") attachExclusiveHost(ws, streamId, account.userId, audioSource, activeSimpleHosts, forwardSimpleFrame);
      else if (stream.mode === "raw") attachExclusiveHost(ws, streamId, account.userId, audioSource, activeRawHosts, (id, _accountId, frame) => forwardRawFrame(id, frame));
      else attachHost(ws, streamId, account.userId, audioSource);
    });
    return;
  }

  if (kind === "listen") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (stream.mode === "simple") attachSimpleListener(ws, streamId);
      else if (stream.mode === "raw") attachRawListener(ws, streamId);
      else attachListener(ws, streamId);
    });
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

// Shared by "simple" and "raw" modes: both allow exactly one active host at
// a time, with a second host superseding whoever was streaming before it -
// they only differ in what happens to each frame once it arrives (the
// `forward` callback), passed in by the caller along with which mode's
// active-host map to track this connection in.
function attachExclusiveHost(
  ws: WebSocket,
  streamId: string,
  accountId: number,
  audioSource: HostAudioSource,
  activeHosts: Map<string, { connectionId: string; ws: WebSocket }>,
  forward: (streamId: string, accountId: number, frame: Buffer) => void,
): void {
  const connectionId = randomUUID();

  // A second host starting up on the same stream supersedes whoever was
  // streaming on it - tell that previous connection why it's being cut off
  // (rather than leaving it to guess from a plain close) and disconnect it,
  // instead of letting two sources collide.
  const previous = activeHosts.get(streamId);
  if (previous && previous.connectionId !== connectionId) {
    if (previous.ws.readyState === previous.ws.OPEN) {
      previous.ws.send(JSON.stringify({ type: "superseded" }));
    }
    previous.ws.close();
  }
  activeHosts.set(streamId, { connectionId, ws });

  addActiveHost(streamId, connectionId, accountId, audioSource);

  ws.on("message", (data, isBinary) => {
    if (!isBinary) return;
    // Ignore frames from a connection that's since been superseded but
    // hasn't finished closing yet - only the current active host forwards.
    if (activeHosts.get(streamId)?.connectionId !== connectionId) return;
    const frame = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (frame.length !== BYTES_PER_FRAME) return;
    forward(streamId, accountId, frame);
  });

  ws.on("close", () => {
    if (activeHosts.get(streamId)?.connectionId === connectionId) {
      activeHosts.delete(streamId);
    }
    removeActiveHost(streamId, connectionId, accountId);
  });
}

function attachSimpleListener(ws: WebSocket, streamId: string): void {
  registerSimpleListener(streamId, ws);
  ws.on("close", () => unregisterSimpleListener(streamId, ws));
}

function attachRawListener(ws: WebSocket, streamId: string): void {
  registerRawListener(streamId, ws);
  ws.on("close", () => unregisterRawListener(streamId, ws));
}
