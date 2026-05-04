export interface StoredAccount {
  id: string;
  email: string;
  displayName?: string;
  provider: 'google-drive' | string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

export interface AccountInfo {
  id: string;
  email: string;
  displayName?: string;
  provider: string;
}
