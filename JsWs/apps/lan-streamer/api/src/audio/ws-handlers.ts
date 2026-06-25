import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { accountForToken } from "../auth.js";
import { addActiveHost, getStream, removeActiveHost } from "../store.js";
import {
  BYTES_PER_FRAME,
  pushHostFrame,
  registerHost,
  registerListener,
  unregisterHost,
  unregisterListener,
} from "./mixer.js";

const wss = new WebSocketServer({ noServer: true });

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
    wss.handleUpgrade(req, socket, head, (ws) => attachHost(ws, streamId, account.userId));
    return;
  }

  if (kind === "listen") {
    wss.handleUpgrade(req, socket, head, (ws) => attachListener(ws, streamId));
    return;
  }

  closeWith(socket, 404, "Not Found");
}

function attachHost(ws: WebSocket, streamId: string, accountId: number): void {
  const connectionId = randomUUID();

  registerHost(streamId, connectionId);
  addActiveHost(streamId, accountId);

  ws.on("message", (data, isBinary) => {
    if (!isBinary) return;
    const frame = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (frame.length !== BYTES_PER_FRAME) return;
    pushHostFrame(streamId, connectionId, frame);
  });

  ws.on("close", () => {
    unregisterHost(streamId, connectionId);
    removeActiveHost(streamId, accountId);
  });
}

function attachListener(ws: WebSocket, streamId: string): void {
  registerListener(streamId, ws);
  ws.on("close", () => unregisterListener(streamId, ws));
}
