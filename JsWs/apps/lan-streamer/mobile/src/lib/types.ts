export interface FilenAccount {
  userId: number;
  email: string;
}

export type HostAudioSource = "microphone" | "system" | "test-tone";

export interface ActiveHost {
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
  activeHosts: ActiveHost[];
  pausedHostAccountIds: number[];
}

export interface Session {
  apiBaseUrl: string;
  token: string;
  account: FilenAccount;
}

export interface AccountSettings {
  /** fraction of full-scale 16-bit PCM a single device stream's peak amplitude is limited to before mixing */
  maxDeviceAmplitude: number;
}
