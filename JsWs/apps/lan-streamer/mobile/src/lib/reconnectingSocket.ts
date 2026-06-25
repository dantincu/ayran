export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface ReconnectingSocketHandlers {
  onOpen?: () => void;
  onMessage?: (event: MessageEvent) => void;
  onStatusChange?: (status: ConnectionStatus, attempt: number) => void;
}

export interface ReconnectingSocket {
  /** Sends data if currently connected; silently drops it otherwise (caller doesn't need to track connectivity). */
  send: (data: ArrayBuffer | ArrayBufferView) => void;
  /** Stops reconnect attempts and closes the active connection, if any. */
  close: () => void;
}

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

/**
 * Wraps a WebSocket with automatic reconnect + exponential backoff (capped at
 * 30s, uncapped attempt count - the caller can always `close()` to give up).
 * The backoff resets to the initial delay after any successful connection.
 */
export function connectWithBackoff(urlFactory: () => string, handlers: ReconnectingSocketHandlers): ReconnectingSocket {
  let stopped = false;
  let attempt = 0;
  let ws: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function scheduleReconnect() {
    if (stopped) return;
    attempt += 1;
    const delay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
    handlers.onStatusChange?.("reconnecting", attempt);
    timer = setTimeout(connect, delay);
  }

  function connect() {
    if (stopped) return;
    handlers.onStatusChange?.(attempt === 0 ? "connecting" : "reconnecting", attempt);

    const socket = new WebSocket(urlFactory());
    socket.binaryType = "arraybuffer";
    ws = socket;

    socket.onopen = () => {
      if (stopped) {
        socket.close();
        return;
      }
      attempt = 0;
      handlers.onStatusChange?.("open", 0);
      handlers.onOpen?.();
    };
    socket.onmessage = (event) => handlers.onMessage?.(event);
    socket.onclose = () => {
      if (ws === socket) ws = undefined;
      if (stopped) return;
      scheduleReconnect();
    };
    socket.onerror = () => {
      // onclose always follows onerror for WebSocket; reconnect is scheduled there.
    };
  }

  connect();

  return {
    send: (data) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(data);
    },
    close: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      ws?.close();
      ws = undefined;
    },
  };
}
