import { BaseStorageProvider } from '../BaseStorageProvider';
import { StorageProviderType, FileStat } from '../../types/storage.types';
import { GoogleDriveAuth, GoogleTokens } from './GoogleDriveAuth';

const API_BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

export class GoogleDriveProvider extends BaseStorageProvider {
  readonly type = StorageProviderType.GoogleDrive;
  readonly id: string;

  private auth: GoogleDriveAuth;
  private tokens: GoogleTokens | null = null;
  /** Map from path to Drive file ID */
  private pathToId: Map<string, string> = new Map();

  constructor(id: string, clientId: string) {
    super();
    this.id = id;
    this.auth = new GoogleDriveAuth(clientId);
  }

  async isAuthenticated(): Promise<boolean> {
    if (!this.tokens) {
      this.tokens = await this.auth.getSavedTokens();
    }
    if (!this.tokens) return false;
    if (this.tokens.expiresAt && Date.now() >= this.tokens.expiresAt - 60000) {
      if (this.tokens.refreshToken) {
        try {
          this.tokens = await this.auth.refreshAccessToken(this.tokens.refreshToken);
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
    return true;
  }

  async authenticate(): Promise<void> {
    this.tokens = await this.auth.authenticate();
  }

  async refreshAuth(): Promise<void> {
    if (!this.tokens?.refreshToken) throw new Error('No refresh token available');
    this.tokens = await this.auth.refreshAccessToken(this.tokens.refreshToken);
  }

  private async getAccessToken(): Promise<string> {
    if (!(await this.isAuthenticated())) {
      await this.authenticate();
    }
    return this.tokens!.accessToken;
  }

  private async fetch(url: string, init?: RequestInit): Promise<Response> {
    const token = await this.getAccessToken();
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });
    if (response.status === 401) {
      await this.refreshAuth();
      const newToken = await this.getAccessToken();
      return fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${newToken}`,
          ...(init?.headers ?? {}),
        },
      });
    }
    return response;
  }

  private async getFileId(path: string): Promise<string | null> {
    if (this.pathToId.has(path)) return this.pathToId.get(path)!;

    const segments = path.split('/').filter(Boolean);
    let parentId = 'root';

    for (const segment of segments) {
      const segPath = segments.slice(0, segments.indexOf(segment) + 1).join('/');
      if (this.pathToId.has(segPath)) {
        parentId = this.pathToId.get(segPath)!;
        continue;
      }

      const q = encodeURIComponent(
        `name = '${segment.replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed = false`,
      );
      const res = await this.fetch(`${API_BASE}/files?q=${q}&fields=files(id,name,mimeType)`);
      const data = await res.json();
      const file = data.files?.[0];
      if (!file) return null;
      this.pathToId.set(segPath, file.id);
      parentId = file.id;
    }

    this.pathToId.set(path, parentId);
    return parentId;
  }

  private async getOrCreateFolder(path: string): Promise<string> {
    const existing = await this.getFileId(path);
    if (existing) return existing;

    const segments = path.split('/').filter(Boolean);
    const name = segments[segments.length - 1];
    const parentPath = segments.slice(0, -1).join('/');
    const parentId = parentPath ? await this.getOrCreateFolder(parentPath) : 'root';

    const res = await this.fetch(`${API_BASE}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      }),
    });
    const folder = await res.json();
    this.pathToId.set(path, folder.id);
    return folder.id;
  }

  async readFile(path: string): Promise<string> {
    const fileId = await this.getFileId(path);
    if (!fileId) throw new Error(`File not found: ${path}`);
    const res = await this.fetch(`${API_BASE}/files/${fileId}?alt=media`);
    return res.text();
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const fileId = await this.getFileId(path);
    if (!fileId) throw new Error(`File not found: ${path}`);
    const res = await this.fetch(`${API_BASE}/files/${fileId}?alt=media`);
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.writeFileBytes(path, new TextEncoder().encode(content));
  }

  async writeFileBytes(path: string, content: Uint8Array): Promise<void> {
    const segments = path.split('/').filter(Boolean);
    const name = segments[segments.length - 1];
    const parentPath = segments.slice(0, -1).join('/');
    const parentId = parentPath ? await this.getOrCreateFolder(parentPath) : 'root';

    const existingId = await this.getFileId(path);

    const metadata = JSON.stringify({ name, parents: existingId ? undefined : [parentId] });
    const body = new Blob([
      `--boundary\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n--boundary\r\nContent-Type: application/octet-stream\r\n\r\n`,
      content,
      '\r\n--boundary--',
    ]);

    const url = existingId
      ? `${UPLOAD_BASE}/files/${existingId}?uploadType=multipart`
      : `${UPLOAD_BASE}/files?uploadType=multipart`;

    const res = await this.fetch(url, {
      method: existingId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'multipart/related; boundary=boundary' },
      body,
    });
    const file = await res.json();
    this.pathToId.set(path, file.id);
  }

  async deleteFile(path: string): Promise<void> {
    const fileId = await this.getFileId(path);
    if (!fileId) return;
    await this.fetch(`${API_BASE}/files/${fileId}`, { method: 'DELETE' });
    this.pathToId.delete(path);
  }

  async moveFile(srcPath: string, destPath: string): Promise<void> {
    const fileId = await this.getFileId(srcPath);
    if (!fileId) throw new Error(`File not found: ${srcPath}`);
    const destSegments = destPath.split('/').filter(Boolean);
    const newName = destSegments[destSegments.length - 1];
    const newParentPath = destSegments.slice(0, -1).join('/');
    const newParentId = newParentPath ? await this.getOrCreateFolder(newParentPath) : 'root';
    const oldParentId = await this.getFileId(this.parentPath(srcPath)) ?? 'root';

    await this.fetch(
      `${API_BASE}/files/${fileId}?addParents=${newParentId}&removeParents=${oldParentId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      },
    );
    this.pathToId.delete(srcPath);
    this.pathToId.set(destPath, fileId);
  }

  async copyFile(srcPath: string, destPath: string): Promise<void> {
    const fileId = await this.getFileId(srcPath);
    if (!fileId) throw new Error(`File not found: ${srcPath}`);
    const destSegments = destPath.split('/').filter(Boolean);
    const newName = destSegments[destSegments.length - 1];
    const newParentPath = destSegments.slice(0, -1).join('/');
    const newParentId = newParentPath ? await this.getOrCreateFolder(newParentPath) : 'root';

    const res = await this.fetch(`${API_BASE}/files/${fileId}/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName, parents: [newParentId] }),
    });
    const copy = await res.json();
    this.pathToId.set(destPath, copy.id);
  }

  async listDir(path: string): Promise<FileStat[]> {
    const folderId = path ? await this.getFileId(path) : null;
    const parentId = folderId ?? 'root';
    const q = encodeURIComponent(`'${parentId}' in parents and trashed = false`);
    const res = await this.fetch(
      `${API_BASE}/files?q=${q}&fields=files(id,name,mimeType,size,modifiedTime)&pageSize=1000`,
    );
    const data = await res.json();
    return (data.files ?? []).map((f: any) => ({
      name: f.name,
      path: path ? `${path}/${f.name}` : f.name,
      isDirectory: f.mimeType === 'application/vnd.google-apps.folder',
      size: f.size ? parseInt(f.size, 10) : undefined,
      modifiedAt: f.modifiedTime,
    }));
  }

  async createDir(path: string): Promise<void> {
    await this.getOrCreateFolder(path);
  }

  async deleteDir(path: string): Promise<void> {
    await this.deleteFile(path);
  }

  async moveDir(srcPath: string, destPath: string): Promise<void> {
    await this.moveFile(srcPath, destPath);
  }

  async exists(path: string): Promise<boolean> {
    const id = await this.getFileId(path);
    return id !== null;
  }

  async stat(path: string): Promise<FileStat | null> {
    const fileId = await this.getFileId(path);
    if (!fileId) return null;
    const res = await this.fetch(`${API_BASE}/files/${fileId}?fields=id,name,mimeType,size,modifiedTime`);
    const f = await res.json();
    return {
      name: f.name,
      path,
      isDirectory: f.mimeType === 'application/vnd.google-apps.folder',
      size: f.size ? parseInt(f.size, 10) : undefined,
      modifiedAt: f.modifiedTime,
    };
  }
}
