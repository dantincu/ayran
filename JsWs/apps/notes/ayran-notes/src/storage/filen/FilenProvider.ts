import { BaseStorageProvider } from '../BaseStorageProvider';
import { StorageProviderType, FileStat } from '../../types/storage.types';
import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'filen_credentials';

interface FilenCredentials {
  email: string;
  /** Stored API key / session token */
  apiKey: string;
}

/**
 * Filen.IO storage provider.
 * Filen uses email/password login with end-to-end encryption.
 * This implementation uses the @filen/sdk when available.
 */
export class FilenProvider extends BaseStorageProvider {
  readonly type = StorageProviderType.Filen;
  readonly id: string;

  private credentials: FilenCredentials | null = null;
  private sdk: any = null; // @filen/sdk FilenSDK instance

  constructor(id: string) {
    super();
    this.id = id;
  }

  private async getSDK(): Promise<any> {
    if (this.sdk) return this.sdk;
    // Dynamic import to avoid bundling if not needed
    const { FilenSDK } = await import('@filen/sdk');
    this.sdk = new FilenSDK({});
    return this.sdk;
  }

  async isAuthenticated(): Promise<boolean> {
    if (!this.credentials) {
      const raw = await SecureStore.getItemAsync(TOKEN_KEY);
      if (raw) this.credentials = JSON.parse(raw);
    }
    return !!this.credentials?.apiKey;
  }

  async authenticate(email?: string, password?: string): Promise<void> {
    if (!email || !password) {
      throw new Error('Email and password required for Filen.IO');
    }
    const sdk = await this.getSDK();
    await sdk.login({ email, password });
    const apiKey = sdk.config?.apiKey ?? '';
    this.credentials = { email, apiKey };
    await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(this.credentials));
  }

  async refreshAuth(): Promise<void> {
    // Filen tokens don't expire in the traditional sense; re-auth if needed
    if (!this.credentials) throw new Error('No credentials available');
  }

  async readFile(path: string): Promise<string> {
    const bytes = await this.readFileBytes(path);
    return new TextDecoder().decode(bytes);
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const sdk = await this.getSDK();
    const buffer = await sdk.fs().readFile({ path });
    return new Uint8Array(buffer);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.writeFileBytes(path, new TextEncoder().encode(content));
  }

  async writeFileBytes(path: string, content: Uint8Array): Promise<void> {
    const sdk = await this.getSDK();
    await sdk.fs().writeFile({ path, content: Buffer.from(content) });
  }

  async deleteFile(path: string): Promise<void> {
    const sdk = await this.getSDK();
    await sdk.fs().unlink({ path });
  }

  async moveFile(srcPath: string, destPath: string): Promise<void> {
    const sdk = await this.getSDK();
    await sdk.fs().rename({ from: srcPath, to: destPath });
  }

  async copyFile(srcPath: string, destPath: string): Promise<void> {
    const sdk = await this.getSDK();
    await sdk.fs().copy({ from: srcPath, to: destPath });
  }

  async listDir(path: string): Promise<FileStat[]> {
    const sdk = await this.getSDK();
    const items = await sdk.fs().readdir({ path: path || '/' });
    return (items ?? []).map((item: any) => ({
      name: item.name,
      path: `${path}/${item.name}`.replace(/\/+/g, '/'),
      isDirectory: item.type === 'directory',
      size: item.size,
      modifiedAt: item.lastModified ? new Date(item.lastModified).toISOString() : undefined,
    }));
  }

  async createDir(path: string): Promise<void> {
    const sdk = await this.getSDK();
    await sdk.fs().mkdir({ path });
  }

  async deleteDir(path: string): Promise<void> {
    const sdk = await this.getSDK();
    await sdk.fs().unlink({ path, permanent: false });
  }

  async moveDir(srcPath: string, destPath: string): Promise<void> {
    await this.moveFile(srcPath, destPath);
  }

  async exists(path: string): Promise<boolean> {
    try {
      const sdk = await this.getSDK();
      await sdk.fs().stat({ path });
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FileStat | null> {
    try {
      const sdk = await this.getSDK();
      const s = await sdk.fs().stat({ path });
      return {
        name: this.baseName(path),
        path,
        isDirectory: s.type === 'directory',
        size: s.size,
        modifiedAt: s.lastModified ? new Date(s.lastModified).toISOString() : undefined,
      };
    } catch {
      return null;
    }
  }
}
