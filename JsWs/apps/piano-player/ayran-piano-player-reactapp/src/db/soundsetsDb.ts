import { getDb, Soundset, SoundsetNote } from './schema'

export async function getAllSoundsets(): Promise<Soundset[]> {
  const db = await getDb()
  return db.getAll('soundsets')
}

export async function saveSoundset(soundset: Soundset): Promise<void> {
  const db = await getDb()
  await db.put('soundsets', soundset)
}

export async function deleteSoundset(id: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(['soundsets', 'soundset_notes'], 'readwrite')
  await tx.objectStore('soundsets').delete(id)
  // Delete all notes for this soundset
  const notesStore = tx.objectStore('soundset_notes')
  const index = notesStore.index('soundsetId')
  let cursor = await index.openCursor(IDBKeyRange.only(id))
  while (cursor) {
    await cursor.delete()
    cursor = await cursor.continue()
  }
  await tx.done
}

export async function saveSoundsetNote(note: SoundsetNote): Promise<void> {
  const db = await getDb()
  await db.put('soundset_notes', note)
}

export async function getSoundsetNote(
  soundsetId: string,
  noteCode: string
): Promise<SoundsetNote | undefined> {
  const db = await getDb()
  return db.get('soundset_notes', [soundsetId, noteCode])
}

export async function getSoundsetNoteCount(soundsetId: string): Promise<number> {
  const db = await getDb()
  const index = db.transaction('soundset_notes', 'readonly')
    .objectStore('soundset_notes')
    .index('soundsetId')
  return index.count(IDBKeyRange.only(soundsetId))
}

export async function deleteSoundsetNote(
  soundsetId: string,
  noteCode: string
): Promise<void> {
  const db = await getDb()
  await db.delete('soundset_notes', [soundsetId, noteCode])
}
