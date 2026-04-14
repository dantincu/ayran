import { getDb, SettingsKey } from './schema'

export async function getSetting<T>(key: SettingsKey): Promise<T | undefined> {
  const db = await getDb()
  const record = await db.get('settings', key)
  return record?.value as T | undefined
}

export async function setSetting(key: SettingsKey, value: unknown): Promise<void> {
  const db = await getDb()
  await db.put('settings', { key, value })
}
