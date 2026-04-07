import { IStorageProvider } from '../types/storage.types';
import { NoteJson, NoteChildrenJson, NoteChildEntry, NoteMetadata } from '../types/note.types';
import constants from '../../config/app-constants.json';

const { fileNames } = constants;

/**
 * Read [note].json from a note's short name folder.
 */
export async function readNoteJson(
  provider: IStorageProvider,
  shortNameFolderPath: string,
): Promise<NoteJson> {
  const filePath = provider.joinPath(shortNameFolderPath, fileNames.noteJson);
  const content = await provider.readFile(filePath);
  return JSON.parse(content) as NoteJson;
}

/**
 * Read [note-children].json from a note's short name folder.
 * Returns an empty children map if the file doesn't exist.
 */
export async function readNoteChildrenJson(
  provider: IStorageProvider,
  shortNameFolderPath: string,
): Promise<NoteChildrenJson> {
  const filePath = provider.joinPath(shortNameFolderPath, fileNames.noteChildrenJson);
  const exists = await provider.exists(filePath);
  if (!exists) return { ChildNotes: {} };
  const content = await provider.readFile(filePath);
  return JSON.parse(content) as NoteChildrenJson;
}

/**
 * Read the markdown content of a note.
 * Returns null if the markdown file doesn't exist.
 */
export async function readNoteMarkdown(
  provider: IStorageProvider,
  shortNameFolderPath: string,
  mdFileName: string,
): Promise<string | null> {
  const filePath = provider.joinPath(shortNameFolderPath, mdFileName);
  const exists = await provider.exists(filePath);
  if (!exists) return null;
  return provider.readFile(filePath);
}

/**
 * List all immediate child note short-name folders inside a parent's short name folder.
 * Returns an array of {index, shortName} pairs for notes found on disk.
 */
export async function listChildNoteFolders(
  provider: IStorageProvider,
  parentShortNameFolderPath: string,
): Promise<{ index: number; shortName: string }[]> {
  const items = await provider.listDir(parentShortNameFolderPath);
  const result: { index: number; shortName: string }[] = [];
  for (const item of items) {
    if (!item.isDirectory) continue;
    const match = item.name.match(/^(\d{3})$/);
    if (match) {
      result.push({ index: parseInt(match[1], 10), shortName: item.name });
    }
  }
  return result;
}

/**
 * Build a NoteMetadata from a NoteJson and its position in the hierarchy.
 */
export function buildNoteMetadata(
  noteJson: NoteJson,
  index: string,
  notePath: string,
): NoteMetadata {
  return {
    index,
    title: noteJson.Title,
    createdAt: noteJson.CreatedAt,
    starred: noteJson.Starred ?? false,
    labelColor: noteJson.LabelColor ?? null,
    notePath,
  };
}

/**
 * Resolve the short-name folder path for a note given its path segments.
 * notePath is a slash-separated list of short-name folder names, e.g. "999/998"
 */
export function resolveShortNameFolderPath(
  provider: IStorageProvider,
  notebookRootPath: string,
  notePath: string,
): string {
  const segments = notePath.split('/').filter(Boolean);
  return provider.joinPath(notebookRootPath, ...segments);
}

/**
 * Convert a NoteChildEntry to NoteMetadata.
 */
export function childEntryToMetadata(
  entry: NoteChildEntry,
  index: string,
  parentNotePath: string,
): NoteMetadata {
  const notePath = parentNotePath ? `${parentNotePath}/${index}` : index;
  return {
    index,
    title: entry.Title,
    createdAt: entry.CreatedAt,
    starred: entry.Starred ?? false,
    labelColor: entry.LabelColor ?? null,
    notePath,
  };
}
