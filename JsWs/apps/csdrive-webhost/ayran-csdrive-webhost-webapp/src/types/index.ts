export interface StoredAccount {
  id: string;
  email: string;
  displayName?: string;
  provider: 'google-drive' | 'filen' | string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  providerData?: Record<string, unknown>;
}

export interface AccountInfo {
  id: string;
  email: string;
  displayName?: string;
  provider: string;
}

export interface FsAccountInfo {
  id: string;
  name: string;
  provider: 'file-system';
}
