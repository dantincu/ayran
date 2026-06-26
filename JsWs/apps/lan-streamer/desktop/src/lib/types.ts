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

export interface StreamRecord {
  id: string;
  name: string;
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
