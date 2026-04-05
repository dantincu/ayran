export type AppPhase =
  | 'initializing'
  | 'setup'
  | 'restoring'
  | 'loading'
  | 'ready'
  | 'error'

export interface StoredConfig {
  rootDirUri: string
  rootDirName: string
  /** Optional separate folder the user picked for watch history / resume data. */
  dataFolderUri: string | null
  dataFolderName: string | null
  /** Cached SAF URI of state.json in the data folder. Null until first resolved. */
  stateFileUri: string | null
}

export interface AppState {
  lastPlayedPath: string | null
  positions: Record<string, number>
  watched: Record<string, true>
}

export interface FileNode {
  name: string
  path: string    // relative path from root (e.g. "Series/Season 1/ep1.mp4")
  uri: string     // SAF content URI for file access
  kind: 'file' | 'directory'
  children?: FileNode[]
}

export function defaultAppState(): AppState {
  return { lastPlayedPath: null, positions: {}, watched: {} }
}
