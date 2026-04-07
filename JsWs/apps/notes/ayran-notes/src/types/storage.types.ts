export enum StorageProviderType {
  Local = 'local',
  GoogleDrive = 'google-drive',
  OneDrive = 'onedrive',
  Dropbox = 'dropbox',
  Filen = 'filen',
}

export interface StorageProviderConfig {
  type: StorageProviderType;
  /** For local: the root path chosen by the user. For cloud: optional display label. */
  rootPath?: string;
  /** OAuth tokens or API keys, encrypted at rest */
  authData?: Record<string, string>;
}

export interface FileStat {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modifiedAt?: string;
}

export interface IStorageProvider {
  readonly type: StorageProviderType;
  readonly id: string;

  isAuthenticated(): Promise<boolean>;
  authenticate(): Promise<void>;
  refreshAuth(): Promise<void>;

  readFile(path: string): Promise<string>;
  readFileBytes(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  writeFileBytes(path: string, content: Uint8Array): Promise<void>;
  deleteFile(path: string): Promise<void>;
  moveFile(srcPath: string, destPath: string): Promise<void>;
  copyFile(srcPath: string, destPath: string): Promise<void>;

  listDir(path: string): Promise<FileStat[]>;
  createDir(path: string): Promise<void>;
  deleteDir(path: string, recursive?: boolean): Promise<void>;
  moveDir(srcPath: string, destPath: string): Promise<void>;

  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat | null>;

  /** Join path segments using the provider's path separator */
  joinPath(...segments: string[]): string;
  /** Get the parent directory of a path */
  parentPath(path: string): string;
  /** Get the base name (last segment) of a path */
  baseName(path: string): string;
}
