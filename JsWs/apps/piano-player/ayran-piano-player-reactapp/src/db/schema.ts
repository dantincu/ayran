import { openDB, IDBPDatabase } from 'idb'

export type Theme = {
  id: string
  name: string
  css: string
  createdAt: number
}

export type Soundset = {
  id: string
  name: string
  noteCount: number
  createdAt: number
}

export type SoundsetNote = {
  soundsetId: string
  noteCode: string
  blob: Blob
}

export type NoteEvent = {
  timestamp: number  // ms from recording start
  note: string
  duration: number   // ms
}

export type Recording = {
  id: string
  name: string | null
  savedAt: number | null
  blueprint: NoteEvent[]
  createdAt: number
}

export type CurrentRecording = {
  singleton: 'current'
  blueprint: NoteEvent[]
  startedAt: number
}

export type SettingsKey =
  | 'activeThemeId'
  | 'activeSoundsetId'
  | 'customSizes'
  | 'activeSize'
  | 'fadeMs'

export type SettingsRecord = {
  key: SettingsKey
  value: unknown
}

const DB_NAME = 'ayran-piano-player'
const DB_VERSION = 1

let dbPromise: Promise<IDBPDatabase> | null = null

export function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('themes')) {
          db.createObjectStore('themes', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('soundsets')) {
          db.createObjectStore('soundsets', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('soundset_notes')) {
          const sns = db.createObjectStore('soundset_notes', {
            keyPath: ['soundsetId', 'noteCode']
          })
          sns.createIndex('soundsetId', 'soundsetId')
        }
        if (!db.objectStoreNames.contains('recordings')) {
          const rec = db.createObjectStore('recordings', { keyPath: 'id' })
          rec.createIndex('savedAt', 'savedAt')
        }
        if (!db.objectStoreNames.contains('current_recording')) {
          db.createObjectStore('current_recording', { keyPath: 'singleton' })
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' })
        }
      }
    })
  }
  return dbPromise
}
