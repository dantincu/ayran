import AsyncStorage from '@react-native-async-storage/async-storage'
import * as FileSystem from 'expo-file-system/legacy'
import type { StoredConfig, AppState } from '../types'
import { defaultAppState } from '../types'

const CONFIG_KEY = 'video-player:config'
const SAF = FileSystem.StorageAccessFramework

// Fallback location when SAF state file cannot be created
const FALLBACK_STATE_FILE = (FileSystem.documentDirectory ?? '') + 'state.json'

const STATE_FILE_NAME = 'state.json'

function getNameFromUri(uri: string): string {
  const decoded = decodeURIComponent(uri)
  const docPart = decoded.split('/document/').pop() ?? decoded
  const lastSegment = docPart.split('/').pop() ?? docPart
  return lastSegment.split(':').pop() ?? lastSegment
}

/**
 * Finds or creates `state.json` directly inside the user-chosen data folder.
 * Returns the SAF URI of the state file, or null if creation fails.
 */
export async function initStateFile(dataFolderUri: string): Promise<string | null> {
  try {
    const children = await SAF.readDirectoryAsync(dataFolderUri)
    const existing = children.find(u => getNameFromUri(u) === STATE_FILE_NAME)
    if (existing) return existing
    return await SAF.createFileAsync(dataFolderUri, STATE_FILE_NAME, 'application/json')
  } catch {
    return null
  }
}

export async function saveConfig(config: StoredConfig): Promise<void> {
  await AsyncStorage.setItem(CONFIG_KEY, JSON.stringify(config))
}

export async function getConfig(): Promise<StoredConfig | null> {
  const raw = await AsyncStorage.getItem(CONFIG_KEY)
  if (!raw) return null
  const parsed = JSON.parse(raw) as Partial<StoredConfig>
  return {
    rootDirUri: parsed.rootDirUri ?? '',
    rootDirName: parsed.rootDirName ?? '',
    dataFolderUri: parsed.dataFolderUri ?? null,
    dataFolderName: parsed.dataFolderName ?? null,
    stateFileUri: parsed.stateFileUri ?? null,
  }
}

export async function clearAll(): Promise<void> {
  await AsyncStorage.removeItem(CONFIG_KEY)
  try {
    await FileSystem.deleteAsync(FALLBACK_STATE_FILE, { idempotent: true })
  } catch {
    // ignore
  }
}

export async function readAppState(stateFileUri?: string | null): Promise<AppState> {
  try {
    const text = stateFileUri
      ? await FileSystem.readAsStringAsync(stateFileUri)
      : await FileSystem.readAsStringAsync(FALLBACK_STATE_FILE)
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

export async function writeAppState(state: AppState, stateFileUri?: string | null): Promise<void> {
  const content = JSON.stringify(state, null, 2)
  if (stateFileUri) {
    await FileSystem.writeAsStringAsync(stateFileUri, content)
  } else {
    await FileSystem.writeAsStringAsync(FALLBACK_STATE_FILE, content)
  }
}
