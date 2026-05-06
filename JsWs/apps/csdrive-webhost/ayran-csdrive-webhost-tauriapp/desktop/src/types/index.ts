export interface StoredAccount {
  id: string;
  email: string;
  displayName?: string;
  provider: 'google-drive' | 'filen' | 'local-fs';
  // Google Drive
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  // Filen — full SDK config stored here (includes master keys)
  providerData?: Record<string, unknown>;
  // Local file system — absolute path to the root directory
  path?: string;
}

export interface AccountInfo {
  id: string;
  email: string;
  displayName?: string;
  provider: string;
  path?: string;
}