import { NOTE_CODES } from '../constants/piano'

// Match filenames like note-C4.mp3, note-Bb3.mp3, note-Db5.mp3
const NOTE_FILE_REGEX = /^note-([A-Ga-g][b#]?[0-8])\.mp3$/i

export type ParsedNoteFile = {
  noteCode: string
  file: File
}

export function parseNoteFilename(filename: string): string | null {
  const match = filename.match(NOTE_FILE_REGEX)
  if (!match) return null
  // Normalize: capitalize note letter, keep b/# as-is
  const raw = match[1]
  // Try to find a matching noteCode (case-insensitive comparison)
  const normalized = raw.charAt(0).toUpperCase() + raw.slice(1)
  const found = NOTE_CODES.find(
    n => n.toLowerCase() === normalized.toLowerCase()
  )
  return found ?? null
}

export async function parseFolderForNotes(
  dirHandle: FileSystemDirectoryHandle
): Promise<ParsedNoteFile[]> {
  const results: ParsedNoteFile[] = []
  for await (const entry of (dirHandle as any).values()) {
    if (entry.kind !== 'file') continue
    const noteCode = parseNoteFilename(entry.name)
    if (!noteCode) continue
    const file = await (entry as FileSystemFileHandle).getFile()
    results.push({ noteCode, file })
  }
  return results
}

export async function parseFilesForNotes(files: FileList): Promise<ParsedNoteFile[]> {
  const results: ParsedNoteFile[] = []
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const noteCode = parseNoteFilename(file.name)
    if (!noteCode) continue
    results.push({ noteCode, file })
  }
  return results
}
