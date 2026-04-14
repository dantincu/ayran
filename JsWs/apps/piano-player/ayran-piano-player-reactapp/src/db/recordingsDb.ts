import { getDb, Recording, CurrentRecording, NoteEvent } from './schema'

export async function getAllRecordings(): Promise<Recording[]> {
  const db = await getDb()
  return db.getAll('recordings')
}

export async function saveRecording(recording: Recording): Promise<void> {
  const db = await getDb()
  await db.put('recordings', recording)
}

export async function deleteRecording(id: string): Promise<void> {
  const db = await getDb()
  await db.delete('recordings', id)
}

export async function getCurrentRecording(): Promise<CurrentRecording | undefined> {
  const db = await getDb()
  return db.get('current_recording', 'current')
}

export async function saveCurrentRecording(
  blueprint: NoteEvent[],
  startedAt: number
): Promise<void> {
  const db = await getDb()
  await db.put('current_recording', { singleton: 'current', blueprint, startedAt })
}

export async function clearCurrentRecording(): Promise<void> {
  const db = await getDb()
  await db.delete('current_recording', 'current')
}
