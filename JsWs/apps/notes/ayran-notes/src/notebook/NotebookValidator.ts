import { IStorageProvider } from '../types/storage.types';
import { NotebookJson } from '../types/notebook.types';
import { NoteInternalDir } from '../types/note.types';
import constants from '../../config/app-constants.json';

const { fileNames } = constants;

export class NotebookValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotebookValidationError';
  }
}

const VALID_INTERNAL_DIR_VALUES = new Set(Object.values(NoteInternalDir).filter(
  (v) => typeof v === 'number',
));

/**
 * Validate a parsed NotebookJson object.
 * Throws NotebookValidationError if invalid.
 */
export function validateNotebookJson(data: unknown): NotebookJson {
  if (typeof data !== 'object' || data === null) {
    throw new NotebookValidationError('This folder is not valid as a notebook root folder.');
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj['Title'] !== 'string' || (obj['Title'] as string).trim().length === 0) {
    throw new NotebookValidationError('This folder is not valid as a notebook root folder.');
  }

  if (obj['InternalDirs'] !== undefined) {
    if (typeof obj['InternalDirs'] !== 'object' || obj['InternalDirs'] === null) {
      throw new NotebookValidationError('This folder is not valid as a notebook root folder.');
    }
    const dirs = obj['InternalDirs'] as Record<string, unknown>;
    for (const [, val] of Object.entries(dirs)) {
      if (!VALID_INTERNAL_DIR_VALUES.has(val as NoteInternalDir)) {
        throw new NotebookValidationError('This folder is not valid as a notebook root folder.');
      }
    }
  }

  return data as NotebookJson;
}

/**
 * Try to open an existing notebook at the given root path.
 * Returns the NotebookJson if valid, throws NotebookValidationError if not.
 * Returns null if [note-book].json doesn't exist (new notebook).
 */
export async function tryOpenNotebook(
  provider: IStorageProvider,
  rootPath: string,
): Promise<NotebookJson | null> {
  const notebookJsonPath = provider.joinPath(rootPath, fileNames.notebookJson);
  const exists = await provider.exists(notebookJsonPath);

  if (!exists) return null;

  const content = await provider.readFile(notebookJsonPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new NotebookValidationError('This folder is not valid as a notebook root folder.');
  }

  return validateNotebookJson(parsed);
}
