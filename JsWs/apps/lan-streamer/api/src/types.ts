export interface FilenAccount {
  userId: number;
  email: string;
}

export interface Session {
  token: string;
  account: FilenAccount;
  createdAt: number;
}

export type StreamRole = "idle" | "hosting" | "listening";

export type HostAudioSource = "microphone" | "system" | "test-tone";

export interface ActiveHost {
  /** identifies one host WebSocket connection (one "device stream") */
  connectionId: string;
  accountId: number;
  audioSource: HostAudioSource;
}

/**
 * "merged": any number of hosts can stream into it at once, mixed together.
 * "simple": exactly one host streams at a time, forwarded directly (no
 * mixing) - a second host starting up immediately supersedes whichever one
 * was previously streaming on it.
 */
export type StreamMode = "merged" | "simple";

export interface StreamRecord {
  id: string;
  name: string;
  mode: StreamMode;
  ownerAccountId: number;
  createdAt: number;
  /** currently connected host connections feeding audio into this stream */
  activeHosts: ActiveHost[];
  /** accountId -> paused flag, for hosts that joined but paused streaming */
  pausedHostAccountIds: number[];
}

export interface AccountSettings {
  /** fraction of full-scale 16-bit PCM a single device stream's peak amplitude is limited to before mixing */
  maxDeviceAmplitude: number;
}
