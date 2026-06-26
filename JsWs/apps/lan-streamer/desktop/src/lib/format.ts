import type { ActiveHost } from "./types";
import type { ConnectionStatus } from "./reconnectingSocket";

export function connectionStatusLabel(status: ConnectionStatus, attempt: number): string {
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

export function activeHostsSummary(activeHosts: ActiveHost[] | undefined): string {
  if (!activeHosts || activeHosts.length === 0) return "0 active hosts";
  const micCount = activeHosts.filter((h) => h.audioSource === "microphone").length;
  const systemCount = activeHosts.filter((h) => h.audioSource === "system").length;
  const testToneCount = activeHosts.filter((h) => h.audioSource === "test-tone").length;
  const parts: string[] = [];
  if (micCount > 0) parts.push(`${micCount} mic`);
  if (systemCount > 0) parts.push(`${systemCount} system`);
  if (testToneCount > 0) parts.push(`${testToneCount} test tone`);
  return `${activeHosts.length} active host(s) (${parts.join(", ")})`;
}
