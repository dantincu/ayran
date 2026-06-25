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

export interface StreamRecord {
  id: string;
  name: string;
  ownerAccountId: number;
  createdAt: number;
  /** account IDs of hosts currently sending audio into this stream */
  activeHostAccountIds: number[];
  /** accountId -> paused flag, for hosts that joined but paused streaming */
  pausedHostAccountIds: number[];
}
