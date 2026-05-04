export interface StorageProvider {
  id: string;
  name: string;
  displayName: string;
  authUrlEndpoint: string;
  callbackEndpoint: string;
}

export interface StorageFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  modifiedTime?: string;
  isFolder: boolean;
}

export const GOOGLE_DRIVE_PROVIDER: StorageProvider = {
  id: 'google-drive',
  name: 'google-drive',
  displayName: 'Google Drive',
  authUrlEndpoint: '/api/auth/google',
  callbackEndpoint: '/api/auth/google/callback',
};
