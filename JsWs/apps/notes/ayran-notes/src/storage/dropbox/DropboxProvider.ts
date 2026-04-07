import { BaseStorageProvider } from '../BaseStorageProvider';
import { StorageProviderType, FileStat } from '../../types/storage.types';
import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'dropbox_tokens';
const API_BASE = 'https://api.dropboxapi.com/2';
const CONTENT_BASE = 'https://content.dropboxapi.com/2';

interface DropboxTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export class DropboxProvider extends BaseStorageProvider {
  readonly type = StorageProviderType.Dropbox;
  readonly id: string;

  private clientId: string;
  private tokens: DropboxTokens | null = null;

  constructor(id: string, clientId: string) {
    super();
    this.id = id;
    this.clientId = clientId;
  }

  private normalizePath(path: string): string {
    const clean = '/' + path.replace(/^\/+/, '');
    return clean === '/' ? '' : clean; // Dropbox root is empty string
  }

  async isAuthenticated(): Promise<boolean> {
    if (!this.tokens) {
      const raw = await SecureStore.getItemAsync(TOKEN_KEY);
      if (raw) this.tokens = JSON.parse(raw);
    }
    return !!this.tokens?.accessToken;
  }

  async authenticate(): Promise<void> {
    const redirectUri = AuthSession.makeRedirectUri({ scheme: 'ayran-notes' });
    const request = new AuthSession.AuthRequest({
      clientId: this.clientId,
      scopes: ['files.content.write', 'files.content.read', 'files.metadata.write', 'files.metadata.read'],
      redirectUri,
      responseType: AuthSession.ResponseType.Code,
      usePKCE: true,
    });

    const result = await request.promptAsync({
      authorizationEndpoint: 'https://www.dropbox.com/oauth2/authorize',
    });
    if (result.type !== 'success') throw new Error('Dropbox authentication cancelled');

    const tokenRes = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: result.params.code,
        grant_type: 'authorization_code',
        client_id: this.clientId,
        redirect_uri: redirectUri,
        code_verifier: request.codeVerifier ?? '',
      }).toString(),
    });
    const data = await tokenRes.json();
    this.tokens = { accessToken: data.access_token, refreshToken: data.refresh_token };
    await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(this.tokens));
  }

  async refreshAuth(): Promise<void> {
    if (!this.tokens?.refreshToken) throw new Error('No refresh token');
    const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: this.tokens.refreshToken,
        grant_type: 'refresh_token',
        client_id: this.clientId,
      }).toString(),
    });
    const data = await res.json();
    this.tokens = { ...this.tokens, accessToken: data.access_token };
    await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(this.tokens));
  }

  private async fetch(url: string, init?: RequestInit): Promise<Response> {
    if (!(await this.isAuthenticated())) await this.authenticate();
    return fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.tokens!.accessToken}`,
        ...(init?.headers ?? {}),
      },
    });
  }

  async readFile(path: string): Promise<string> {
    const bytes = await this.readFileBytes(path);
    return new TextDecoder().decode(bytes);
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const res = await this.fetch(`${CONTENT_BASE}/files/download`, {
      method: 'POST',
      headers: {
        'Dropbox-API-Arg': JSON.stringify({ path: this.normalizePath(path) }),
        'Content-Type': 'text/plain',
      },
    });
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.writeFileBytes(path, new TextEncoder().encode(content));
  }

  async writeFileBytes(path: string, content: Uint8Array): Promise<void> {
    await this.fetch(`${CONTENT_BASE}/files/upload`, {
      method: 'POST',
      headers: {
        'Dropbox-API-Arg': JSON.stringify({
          path: this.normalizePath(path),
          mode: 'overwrite',
          autorename: false,
        }),
        'Content-Type': 'application/octet-stream',
      },
      body: content,
    });
  }

  async deleteFile(path: string): Promise<void> {
    await this.fetch(`${API_BASE}/files/delete_v2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: this.normalizePath(path) }),
    });
  }

  async moveFile(srcPath: string, destPath: string): Promise<void> {
    await this.fetch(`${API_BASE}/files/move_v2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from_path: this.normalizePath(srcPath),
        to_path: this.normalizePath(destPath),
        autorename: false,
      }),
    });
  }

  async copyFile(srcPath: string, destPath: string): Promise<void> {
    await this.fetch(`${API_BASE}/files/copy_v2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from_path: this.normalizePath(srcPath),
        to_path: this.normalizePath(destPath),
        autorename: false,
      }),
    });
  }

  async listDir(path: string): Promise<FileStat[]> {
    const res = await this.fetch(`${API_BASE}/files/list_folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: this.normalizePath(path), limit: 2000 }),
    });
    const data = await res.json();
    return (data.entries ?? []).map((e: any) => ({
      name: e.name,
      path: path ? `${path}/${e.name}` : e.name,
      isDirectory: e['.tag'] === 'folder',
      size: e.size,
      modifiedAt: e.client_modified,
    }));
  }

  async createDir(path: string): Promise<void> {
    await this.fetch(`${API_BASE}/files/create_folder_v2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: this.normalizePath(path), autorename: false }),
    });
  }

  async deleteDir(path: string): Promise<void> {
    await this.deleteFile(path);
  }

  async moveDir(srcPath: string, destPath: string): Promise<void> {
    await this.moveFile(srcPath, destPath);
  }

  async exists(path: string): Promise<boolean> {
    try {
      const res = await this.fetch(`${API_BASE}/files/get_metadata`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: this.normalizePath(path) }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FileStat | null> {
    try {
      const res = await this.fetch(`${API_BASE}/files/get_metadata`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: this.normalizePath(path) }),
      });
      if (!res.ok) return null;
      const e = await res.json();
      return {
        name: e.name,
        path,
        isDirectory: e['.tag'] === 'folder',
        size: e.size,
        modifiedAt: e.client_modified,
      };
    } catch {
      return null;
    }
  }
}
