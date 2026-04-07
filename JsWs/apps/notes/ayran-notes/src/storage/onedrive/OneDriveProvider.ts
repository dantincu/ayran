import { BaseStorageProvider } from '../BaseStorageProvider';
import { StorageProviderType, FileStat } from '../../types/storage.types';
import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';

const API_BASE = 'https://graph.microsoft.com/v1.0/me/drive';
const TOKEN_KEY = 'onedrive_tokens';
const DISCOVERY = AuthSession.useAutoDiscovery('https://login.microsoftonline.com/common/v2.0');

interface OneDriveTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export class OneDriveProvider extends BaseStorageProvider {
  readonly type = StorageProviderType.OneDrive;
  readonly id: string;

  private clientId: string;
  private tokens: OneDriveTokens | null = null;

  constructor(id: string, clientId: string) {
    super();
    this.id = id;
    this.clientId = clientId;
  }

  private encodePath(path: string): string {
    // OneDrive uses :/path/to/item: syntax
    const clean = path.replace(/^\/+/, '');
    return clean ? `/root:/${clean}:` : '/root';
  }

  async isAuthenticated(): Promise<boolean> {
    if (!this.tokens) {
      const raw = await SecureStore.getItemAsync(TOKEN_KEY);
      if (raw) this.tokens = JSON.parse(raw);
    }
    if (!this.tokens) return false;
    if (this.tokens.expiresAt && Date.now() >= this.tokens.expiresAt - 60000) {
      return this.tokens.refreshToken ? true : false;
    }
    return true;
  }

  async authenticate(): Promise<void> {
    const redirectUri = AuthSession.makeRedirectUri({ scheme: 'ayran-notes' });
    const request = new AuthSession.AuthRequest({
      clientId: this.clientId,
      scopes: ['Files.ReadWrite.All', 'offline_access'],
      redirectUri,
      responseType: AuthSession.ResponseType.Code,
    });

    const discovery = {
      authorizationEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    };

    const result = await request.promptAsync(discovery);
    if (result.type !== 'success') throw new Error('OneDrive authentication cancelled');

    const tokenRes = await fetch(discovery.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: result.params.code,
        client_id: this.clientId,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: request.codeVerifier ?? '',
      }).toString(),
    });
    const data = await tokenRes.json();
    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(this.tokens));
  }

  async refreshAuth(): Promise<void> {
    if (!this.tokens?.refreshToken) throw new Error('No refresh token');
    const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: this.tokens.refreshToken,
        client_id: this.clientId,
        grant_type: 'refresh_token',
      }).toString(),
    });
    const data = await tokenRes.json();
    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? this.tokens.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(this.tokens));
  }

  private async getToken(): Promise<string> {
    if (!(await this.isAuthenticated())) await this.authenticate();
    if (this.tokens?.expiresAt && Date.now() >= this.tokens.expiresAt - 60000) {
      await this.refreshAuth();
    }
    return this.tokens!.accessToken;
  }

  private async fetch(url: string, init?: RequestInit): Promise<Response> {
    const token = await this.getToken();
    return fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    });
  }

  async readFile(path: string): Promise<string> {
    const res = await this.fetch(`${API_BASE}${this.encodePath(path)}/content`);
    return res.text();
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const res = await this.fetch(`${API_BASE}${this.encodePath(path)}/content`);
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.fetch(`${API_BASE}${this.encodePath(path)}/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: content,
    });
  }

  async writeFileBytes(path: string, content: Uint8Array): Promise<void> {
    await this.fetch(`${API_BASE}${this.encodePath(path)}/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });
  }

  async deleteFile(path: string): Promise<void> {
    await this.fetch(`${API_BASE}${this.encodePath(path)}`, { method: 'DELETE' });
  }

  async moveFile(srcPath: string, destPath: string): Promise<void> {
    const destSegments = destPath.split('/').filter(Boolean);
    const newName = destSegments[destSegments.length - 1];
    const parentPath = destSegments.slice(0, -1).join('/');
    const parentRef = parentPath
      ? { path: `/${parentPath}` }
      : { id: 'root' };

    await this.fetch(`${API_BASE}${this.encodePath(srcPath)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName, parentReference: parentRef }),
    });
  }

  async copyFile(srcPath: string, destPath: string): Promise<void> {
    const destSegments = destPath.split('/').filter(Boolean);
    const newName = destSegments[destSegments.length - 1];
    const parentPath = destSegments.slice(0, -1).join('/');
    await this.fetch(`${API_BASE}${this.encodePath(srcPath)}/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName, parentReference: { path: `/${parentPath}` } }),
    });
  }

  async listDir(path: string): Promise<FileStat[]> {
    const endpoint = path
      ? `${API_BASE}${this.encodePath(path)}/children`
      : `${API_BASE}/root/children`;
    const res = await this.fetch(`${endpoint}?$select=name,folder,size,lastModifiedDateTime`);
    const data = await res.json();
    return (data.value ?? []).map((f: any) => ({
      name: f.name,
      path: path ? `${path}/${f.name}` : f.name,
      isDirectory: !!f.folder,
      size: f.size,
      modifiedAt: f.lastModifiedDateTime,
    }));
  }

  async createDir(path: string): Promise<void> {
    const segments = path.split('/').filter(Boolean);
    const name = segments[segments.length - 1];
    const parentPath = segments.slice(0, -1).join('/');
    const parentEndpoint = parentPath
      ? `${API_BASE}${this.encodePath(parentPath)}/children`
      : `${API_BASE}/root/children`;
    await this.fetch(parentEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' }),
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
      const res = await this.fetch(`${API_BASE}${this.encodePath(path)}?$select=id`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FileStat | null> {
    try {
      const res = await this.fetch(
        `${API_BASE}${this.encodePath(path)}?$select=name,folder,size,lastModifiedDateTime`,
      );
      if (!res.ok) return null;
      const f = await res.json();
      return {
        name: f.name,
        path,
        isDirectory: !!f.folder,
        size: f.size,
        modifiedAt: f.lastModifiedDateTime,
      };
    } catch {
      return null;
    }
  }
}
