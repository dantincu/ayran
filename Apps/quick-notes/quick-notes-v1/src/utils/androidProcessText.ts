export interface ProcessTextPayload {
  text: string;
  readonly: boolean;
}

interface AndroidProcessTextBridge {
  getPendingText(): string;
  sendTextOut(text: string): void;
}

declare global {
  interface Window {
    AndroidProcessText?: AndroidProcessTextBridge;
  }
}

function parsePayload(raw: string | null | undefined): ProcessTextPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.text !== 'string') return null;
    return { text: parsed.text, readonly: parsed.readonly !== false };
  } catch {
    return null;
  }
}

/** Call once on app mount: consumes the text a cold-start PROCESS_TEXT intent arrived with. */
export function pullPendingProcessText(): ProcessTextPayload | null {
  const bridge = window.AndroidProcessText;
  if (!bridge) return null;
  return parsePayload(bridge.getPendingText());
}

/** Fires when a PROCESS_TEXT intent reaches an already-running app instance. */
export function subscribeProcessTextIn(onReceive: (payload: ProcessTextPayload) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail as ProcessTextPayload | undefined;
    if (detail && typeof detail.text === 'string') {
      onReceive({ text: detail.text, readonly: detail.readonly !== false });
    }
  };
  window.addEventListener('android-process-text', handler);
  return () => window.removeEventListener('android-process-text', handler);
}

/** Sends text back to the app that launched us, replacing its selection, and closes this app. */
export function sendProcessTextOut(text: string): void {
  window.AndroidProcessText?.sendTextOut(text);
}
