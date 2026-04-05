export type AppPhase =
  | 'initializing'
  | 'setup'
  | 'restoring'
  | 'loading'
  | 'ready'
  | 'error'

export interface StoredConfig {
  rootDirName: string
  dataFolderPath: string
}

export interface AppState {
  lastPlayedPath: string | null
  positions: Record<string, number>
  watched: Record<string, true>
}

export interface FileNode {
  name: string
  path: string
  kind: 'file' | 'directory'
  handle: FileSystemFileHandle | FileSystemDirectoryHandle
  children?: FileNode[]
}

export function defaultAppState(): AppState {
  return { lastPlayedPath: null, positions: {}, watched: {} }
}
