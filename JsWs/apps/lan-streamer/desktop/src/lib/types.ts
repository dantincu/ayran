export interface FilenAccount {
  userId: number;
  email: string;
}

export interface StreamRecord {
  id: string;
  name: string;
  ownerAccountId: number;
  createdAt: number;
  activeHostAccountIds: number[];
  pausedHostAccountIds: number[];
}

export interface Session {
  apiBaseUrl: string;
  token: string;
  account: FilenAccount;
}
