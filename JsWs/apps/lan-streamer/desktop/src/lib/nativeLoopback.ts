import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * Starts native system-audio loopback capture (Rust/cpal). Frames arrive
 * already shaped to match the host WebSocket protocol (48kHz mono 16-bit PCM,
 * 960 samples/20ms), so they can be sent straight through `ws.send()`.
 */
export async function startNativeLoopback(onFrame: (frame: ArrayBuffer) => void): Promise<void> {
  const channel = new Channel<number[]>();
  channel.onmessage = (bytes) => {
    onFrame(new Uint8Array(bytes).buffer);
  };
  await invoke("start_loopback_capture", { onFrame: channel });
}

export async function stopNativeLoopback(): Promise<void> {
  await invoke("stop_loopback_capture");
}
