import { IStorageProvider } from '../types/storage.types';
import { NoteChildrenJson, NoteCategory } from '../types/note.types';
import { buildShortName, buildFullName, buildMdFileName, buildHtmlFileName, buildPdfFileName } from './NoteFileNaming';
import { getIndexesForCategory, buildNormalizationMap, formatIndex } from './NoteIndexer';
import { readNoteChildrenJson, readNoteJson } from './NoteReader';
import constants from '../../config/app-constants.json';

const { fileNames } = constants;

/**
 * Normalize note indexes for a given category inside a parent folder.
 * This reassigns indexes starting from the category max downward,
 * ordered by original index (highest first = most recently created).
 */
export async function normalizeNoteIndexes(
  provider: IStorageProvider,
  parentShortNameFolderPath: string,
  category: NoteCategory,
): Promise<void> {
  // Write normalization marker
  const markerPath = provider.joinPath(parentShortNameFolderPath, fileNames.normalizationMarker);
  await provider.writeFile(markerPath, JSON.stringify({ category, startedAt: new Date().toISOString() }));

  try {
    const childrenJson = await readNoteChildrenJson(provider, parentShortNameFolderPath);
    const existingIndexes = getIndexesForCategory(childrenJson, category);
    const normMap = buildNormalizationMap(existingIndexes, category);

    // Build updated children JSON
    const updatedChildren: NoteChildrenJson = { ChildNotes: {} };

    for (const [oldIdx, newIdx] of normMap) {
      const oldIdxStr = formatIndex(oldIdx);
      const newIdxStr = formatIndex(newIdx);

      // Skip if no change
      if (oldIdx === newIdx) {
        updatedChildren.ChildNotes[newIdxStr] = childrenJson.ChildNotes[oldIdxStr];
        continue;
      }

      // Read the note's data
      const oldShortPath = provider.joinPath(parentShortNameFolderPath, oldIdxStr);
      const noteJson = await readNoteJson(provider, oldShortPath);
      const oldTitle = noteJson.Title;

      const oldFullName = buildFullName(oldIdx, oldTitle);
      const newFullName = buildFullName(newIdx, oldTitle);
      const oldMdFileName = buildMdFileName(oldTitle);
      const newMdFileName = buildMdFileName(oldTitle); // md file name doesn't change on renumber

      const newShortPath = provider.joinPath(parentShortNameFolderPath, newIdxStr);
      const oldFullPath = provider.joinPath(parentShortNameFolderPath, oldFullName);
      const newFullPath = provider.joinPath(parentShortNameFolderPath, newFullName);

      // Rename short folder
      await provider.moveDir(oldShortPath, newShortPath);

      // Rename full folder
      if (await provider.exists(oldFullPath)) {
        await provider.moveDir(oldFullPath, newFullPath);
      }

      // Update children entry
      updatedChildren.ChildNotes[newIdxStr] = childrenJson.ChildNotes[oldIdxStr];
    }

    // Keep non-normalized category entries unchanged
    for (const [idxStr, entry] of Object.entries(childrenJson.ChildNotes)) {
      const idx = parseInt(idxStr, 10);
      if (!normMap.has(idx)) {
        updatedChildren.ChildNotes[idxStr] = entry;
      }
    }

    // Write updated children JSON
    await provider.writeFile(
      provider.joinPath(parentShortNameFolderPath, fileNames.noteChildrenJson),
      JSON.stringify(updatedChildren, null, 2),
    );
  } finally {
    // Remove marker
    const markerExists = await provider.exists(markerPath);
    if (markerExists) {
      await provider.deleteFile(markerPath);
    }
  }
}

/**
 * Check if a normalization was interrupted (marker file present).
 * Returns the category if interrupted, null if clean.
 */
export async function checkNormalizationMarker(
  provider: IStorageProvider,
  parentShortNameFolderPath: string,
): Promise<NoteCategory | null> {
  const markerPath = provider.joinPath(parentShortNameFolderPath, fileNames.normalizationMarker);
  if (!(await provider.exists(markerPath))) return null;
  try {
    const content = await provider.readFile(markerPath);
    const data = JSON.parse(content) as { category?: NoteCategory };
    return data.category ?? null;
  } catch {
    return null;
  }
}
