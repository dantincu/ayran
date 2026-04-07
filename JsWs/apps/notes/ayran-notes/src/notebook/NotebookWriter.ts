import { IStorageProvider } from '../types/storage.types';
import { NotebookJson } from '../types/notebook.types';
import { NoteInternalDir } from '../types/note.types';
import { validateTitle } from './NoteFileNaming';
import constants from '../../config/app-constants.json';

const { fileNames } = constants;

/**
 * Create a new notebook at the given root path.
 */
export async function createNotebook(
  provider: IStorageProvider,
  rootPath: string,
  title: string,
): Promise<NotebookJson> {
  validateTitle(title);

  const notebookJson: NotebookJson = {
    Title: title,
    InternalDirs: {},
  };

  const notebookJsonPath = provider.joinPath(rootPath, fileNames.notebookJson);
  await provider.writeFile(notebookJsonPath, JSON.stringify(notebookJson, null, 2));

  return notebookJson;
}

/**
 * Update the notebook title.
 */
export async function updateNotebookTitle(
  provider: IStorageProvider,
  rootPath: string,
  newTitle: string,
): Promise<void> {
  validateTitle(newTitle);

  const notebookJsonPath = provider.joinPath(rootPath, fileNames.notebookJson);
  const content = await provider.readFile(notebookJsonPath);
  const notebookJson: NotebookJson = JSON.parse(content);
  notebookJson.Title = newTitle;
  await provider.writeFile(notebookJsonPath, JSON.stringify(notebookJson, null, 2));
}

/**
 * Get or create the special [note-book] folder pair index.
 * Returns the index number used for the [note-book] folders pair.
 */
export async function ensureNotebookSpecialDir(
  provider: IStorageProvider,
  rootPath: string,
): Promise<{ shortName: string; fullName: string }> {
  const notebookJsonPath = provider.joinPath(rootPath, fileNames.notebookJson);
  const content = await provider.readFile(notebookJsonPath);
  const notebookJson: NotebookJson = JSON.parse(content);

  // Check if already exists
  const internalDirs = notebookJson.InternalDirs ?? {};
  const existingEntry = Object.entries(internalDirs).find(
    ([, val]) => val === NoteInternalDir.Root,
  );

  if (existingEntry) {
    const fullName = existingEntry[0];
    const shortName = fullName.split('-')[0];
    return { shortName, fullName };
  }

  // Find next available special folder index (0-based, starting at 01)
  const items = await provider.listDir(rootPath);
  const usedSpecialIndexes = items
    .filter((i) => i.isDirectory && /^0\d+$/.test(i.name))
    .map((i) => parseInt(i.name, 10));

  let nextIdx = 1;
  while (usedSpecialIndexes.includes(nextIdx)) nextIdx++;

  const shortName = `0${nextIdx}`;
  const fullName = `${shortName}-${constants.specialFolderSuffixes.noteBook}`;

  await provider.createDir(provider.joinPath(rootPath, shortName));
  await provider.createDir(provider.joinPath(rootPath, fullName));
  await provider.writeFile(
    provider.joinPath(rootPath, fullName, constants.specialFolderSuffixes.fullNameKeepFile),
    '',
  );

  notebookJson.InternalDirs = { ...internalDirs, [fullName]: NoteInternalDir.Root };
  await provider.writeFile(notebookJsonPath, JSON.stringify(notebookJson, null, 2));

  return { shortName, fullName };
}
