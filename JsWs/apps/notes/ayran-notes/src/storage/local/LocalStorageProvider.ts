import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import { BaseStorageProvider } from '../BaseStorageProvider';
import { StorageProviderType, FileStat } from '../../types/storage.types';

export class LocalStorageProvider extends BaseStorageProvider {
  readonly type = StorageProviderType.Local;
  readonly id: string;

  /** The user-chosen root directory URI */
  private rootUri: string;

  constructor(id: string, rootUri: string) {
    super();
    this.id = id;
    this.rootUri = this.normalizeUri(rootUri);
  }

  private normalizeUri(uri: string): string {
    if (!uri.endsWith('/')) return uri + '/';
    return uri;
  }

  private toAbsolute(path: string): string {
    if (path.startsWith('file://') || path.startsWith('/')) return path;
    // relative to root
    return this.rootUri + path.replace(/^\/+/, '');
  }

  async isAuthenticated(): Promise<boolean> {
    return true; // local is always "authenticated"
  }

  async authenticate(): Promise<void> {
    // No-op for local storage
  }

  async refreshAuth(): Promise<void> {
    // No-op for local storage
  }

  async readFile(path: string): Promise<string> {
    const uri = this.toAbsolute(path);
    const result = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.UTF8,
    });
    return result;
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const uri = this.toAbsolute(path);
    const b64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const uri = this.toAbsolute(path);
    await this.ensureParentDir(uri);
    await FileSystem.writeAsStringAsync(uri, content, {
      encoding: FileSystem.EncodingType.UTF8,
    });
  }

  async writeFileBytes(path: string, content: Uint8Array): Promise<void> {
    const uri = this.toAbsolute(path);
    await this.ensureParentDir(uri);
    let binary = '';
    for (let i = 0; i < content.length; i++) {
      binary += String.fromCharCode(content[i]);
    }
    const b64 = btoa(binary);
    await FileSystem.writeAsStringAsync(uri, b64, {
      encoding: FileSystem.EncodingType.Base64,
    });
  }

  async deleteFile(path: string): Promise<void> {
    const uri = this.toAbsolute(path);
    await FileSystem.deleteAsync(uri, { idempotent: true });
  }

  async moveFile(srcPath: string, destPath: string): Promise<void> {
    const srcUri = this.toAbsolute(srcPath);
    const destUri = this.toAbsolute(destPath);
    await this.ensureParentDir(destUri);
    await FileSystem.moveAsync({ from: srcUri, to: destUri });
  }

  async copyFile(srcPath: string, destPath: string): Promise<void> {
    const srcUri = this.toAbsolute(srcPath);
    const destUri = this.toAbsolute(destPath);
    await this.ensureParentDir(destUri);
    await FileSystem.copyAsync({ from: srcUri, to: destUri });
  }

  async listDir(path: string): Promise<FileStat[]> {
    const uri = this.toAbsolute(path);
    const normalizedUri = this.normalizeUri(uri);
    const items = await FileSystem.readDirectoryAsync(normalizedUri);
    const stats: FileStat[] = [];
    for (const name of items) {
      const itemUri = normalizedUri + name;
      const info = await FileSystem.getInfoAsync(itemUri);
      stats.push({
        name,
        path: this.joinPath(path, name),
        isDirectory: info.isDirectory ?? false,
        size: info.size,
        modifiedAt: info.modificationTime
          ? new Date(info.modificationTime * 1000).toISOString()
          : undefined,
      });
    }
    return stats;
  }

  async createDir(path: string): Promise<void> {
    const uri = this.toAbsolute(path);
    await FileSystem.makeDirectoryAsync(uri, { intermediates: true });
  }

  async deleteDir(path: string, recursive = true): Promise<void> {
    const uri = this.toAbsolute(path);
    await FileSystem.deleteAsync(uri, { idempotent: true });
  }

  async moveDir(srcPath: string, destPath: string): Promise<void> {
    const srcUri = this.toAbsolute(srcPath);
    const destUri = this.toAbsolute(destPath);
    await FileSystem.moveAsync({ from: srcUri, to: destUri });
  }

  async exists(path: string): Promise<boolean> {
    const uri = this.toAbsolute(path);
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists;
  }

  async stat(path: string): Promise<FileStat | null> {
    const uri = this.toAbsolute(path);
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return null;
    return {
      name: this.baseName(path),
      path,
      isDirectory: info.isDirectory ?? false,
      size: info.size,
      modifiedAt: info.modificationTime
        ? new Date(info.modificationTime * 1000).toISOString()
        : undefined,
    };
  }

  private async ensureParentDir(absoluteUri: string): Promise<void> {
    const parent = this.parentPath(absoluteUri);
    const info = await FileSystem.getInfoAsync(parent);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(parent, { intermediates: true });
    }
  }

  static getDefaultRoot(): string {
    if (Platform.OS === 'android') {
      return FileSystem.StorageAccessFramework?.getUriForDirectoryInRoot?.() ??
        (FileSystem.documentDirectory ?? '/');
    }
    return FileSystem.documentDirectory ?? '/';
  }
}
