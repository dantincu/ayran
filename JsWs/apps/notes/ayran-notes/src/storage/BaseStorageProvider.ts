import { IStorageProvider, StorageProviderType, FileStat } from '../types/storage.types';

export abstract class BaseStorageProvider implements IStorageProvider {
  abstract readonly type: StorageProviderType;
  abstract readonly id: string;

  abstract isAuthenticated(): Promise<boolean>;
  abstract authenticate(): Promise<void>;
  abstract refreshAuth(): Promise<void>;

  abstract readFile(path: string): Promise<string>;
  abstract readFileBytes(path: string): Promise<Uint8Array>;
  abstract writeFile(path: string, content: string): Promise<void>;
  abstract writeFileBytes(path: string, content: Uint8Array): Promise<void>;
  abstract deleteFile(path: string): Promise<void>;
  abstract moveFile(srcPath: string, destPath: string): Promise<void>;
  abstract copyFile(srcPath: string, destPath: string): Promise<void>;

  abstract listDir(path: string): Promise<FileStat[]>;
  abstract createDir(path: string): Promise<void>;
  abstract deleteDir(path: string, recursive?: boolean): Promise<void>;
  abstract moveDir(srcPath: string, destPath: string): Promise<void>;

  abstract exists(path: string): Promise<boolean>;
  abstract stat(path: string): Promise<FileStat | null>;

  joinPath(...segments: string[]): string {
    return segments
      .map((s, i) => (i === 0 ? s : s.replace(/^\/+/, '')))
      .join('/')
      .replace(/\/+/g, '/');
  }

  parentPath(path: string): string {
    const normalized = path.replace(/\/+$/, '');
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash <= 0) return '/';
    return normalized.substring(0, lastSlash);
  }

  baseName(path: string): string {
    const normalized = path.replace(/\/+$/, '');
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash >= 0 ? normalized.substring(lastSlash + 1) : normalized;
  }
}
