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
  // When true all write operations are buffered locally in the shelveset
  shelvesetActive?: boolean;
}

export interface ShelvesetChange {
  id: number;
  accountId: string;
  operation: 'delete' | 'rename' | 'move';
  itemId: string;
  itemName: string;
  parentId: string;
  newName?: string;
  newParentId?: string;
  isDir: boolean;
  createdAt: number;
  displayPath: string;
}

export interface ShelvesetContentItem {
  id: number;
  accountId: string;
  itemId: string;
  itemName: string;
  parentId: string;
  isDir: boolean;
  isNew: boolean;
  createdAt: number;
  displayPath: string;
}

export interface ShelvesetAllChanges {
  structural: ShelvesetChange[];
  content: ShelvesetContentItem[];
}

/** Returned by query_folder_items — one page of items plus the total match count. */
export interface FolderPage {
  items: CachedItem[];
  total: number;
}

/** Mirrors cache::CachedItem in Rust. storageType: 0=LocalFS 1=GoogleDrive 2=Filen */
export interface CachedItem {
  accountId: string;
  accountEmail: string;
  storageType: number;
  itemId: string;
  parentId: string;
  name: string;
  isDir: boolean;
  size: number | null;
  modifiedMs: number | null;
  mimeType: string | null;
}

export interface AccountInfo {
  id: string;
  email: string;
  displayName?: string;
  provider: string;
  path?: string;
}