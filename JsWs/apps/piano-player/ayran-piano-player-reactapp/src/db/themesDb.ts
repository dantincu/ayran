import { getDb, Theme } from './schema'

export async function getAllThemes(): Promise<Theme[]> {
  const db = await getDb()
  return db.getAll('themes')
}

export async function saveTheme(theme: Theme): Promise<void> {
  const db = await getDb()
  await db.put('themes', theme)
}

export async function deleteTheme(id: string): Promise<void> {
  const db = await getDb()
  await db.delete('themes', id)
}

export async function getTheme(id: string): Promise<Theme | undefined> {
  const db = await getDb()
  return db.get('themes', id)
}
