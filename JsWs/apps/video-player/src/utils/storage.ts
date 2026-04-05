import { createStore, get, set, del } from 'idb-keyval'
import type { StoredConfig, AppState } from '../types'
import { defaultAppState } from '../types'

const store = createStore('video-player', 'data')

const ROOT_HANDLE_KEY = 'rootHandle'
const CONFIG_KEY = 'config'

export async function saveRootHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  await set(ROOT_HANDLE_KEY, handle, store)
}

export async function getRootHandle(): Promise<FileSystemDirectoryHandle | null> {
  return (await get<FileSystemDirectoryHandle>(ROOT_HANDLE_KEY, store)) ?? null
}

export async function saveConfig(config: StoredConfig): Promise<void> {
  await set(CONFIG_KEY, config, store)
}

export async function getConfig(): Promise<StoredConfig | null> {
  return (await get<StoredConfig>(CONFIG_KEY, store)) ?? null
}

export async function clearAll(): Promise<void> {
  await del(ROOT_HANDLE_KEY, store)
  await del(CONFIG_KEY, store)
}

export async function verifyPermission(
  handle: FileSystemDirectoryHandle,
  mode: 'read' | 'readwrite' = 'readwrite',
): Promise<boolean> {
  const opts = { mode }
  if ((await handle.queryPermission(opts)) === 'granted') return true
  if ((await handle.requestPermission(opts)) === 'granted') return true
  return false
}

export async function readAppState(dataFolder: FileSystemDirectoryHandle): Promise<AppState> {
  try {
    const fh = await dataFolder.getFileHandle('state.json')
    const file = await fh.getFile()
    const text = await file.text()
    const parsed = JSON.parse(text) as Partial<AppState>
    return {
      lastPlayedPath: parsed.lastPlayedPath ?? null,
      positions: parsed.positions ?? {},
      watched: parsed.watched ?? {},
    }
  } catch {
    return defaultAppState()
  }
}

export async function writeAppState(
  dataFolder: FileSystemDirectoryHandle,
  state: AppState,
): Promise<void> {
  const fh = await dataFolder.getFileHandle('state.json', { create: true })
  const writable = await fh.createWritable()
  await writable.write(JSON.stringify(state, null, 2))
  await writable.close()
}
