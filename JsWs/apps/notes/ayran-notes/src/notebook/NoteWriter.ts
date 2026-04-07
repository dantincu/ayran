import { IStorageProvider } from '../types/storage.types';
import { NoteJson, NoteChildrenJson, NoteChildEntry, NoteCategory, NoteInternalDir } from '../types/note.types';
import {
  buildShortName,
  buildFullName,
  buildMdFileName,
  buildHtmlFileName,
  buildPdfFileName,
  buildInitialNoteMarkdown,
  validateTitle,
} from './NoteFileNaming';
import { allocateNextIndex } from './NoteIndexer';
import { readNoteChildrenJson } from './NoteReader';
import constants from '../../config/app-constants.json';

const { fileNames } = constants;

export interface CreateNoteResult {
  index: string;
  shortNameFolderPath: string;
  fullNameFolderPath: string;
  mdFileName: string;
  notePath: string;
}

/**
 * Create a new note inside the given parent folder.
 * @param parentShortNameFolderPath - The parent's short name folder (or notebook root for root notes)
 * @param parentNotePath - The parent's note path (empty string for root)
 */
export async function createNote(
  provider: IStorageProvider,
  parentShortNameFolderPath: string,
  parentNotePath: string,
  title: string,
  category: NoteCategory = 'regular',
): Promise<CreateNoteResult> {
  validateTitle(title);

  const childrenJson = await readNoteChildrenJson(provider, parentShortNameFolderPath);
  const index = allocateNextIndex(childrenJson, category);
  const indexStr = buildShortName(index);
  const shortName = indexStr;
  const fullName = buildFullName(index, title);
  const mdFileName = buildMdFileName(title);
  const htmlFileName = buildHtmlFileName(mdFileName);
  const pdfFileName = buildPdfFileName(mdFileName);

  const shortNameFolderPath = provider.joinPath(parentShortNameFolderPath, shortName);
  const fullNameFolderPath = provider.joinPath(parentShortNameFolderPath, fullName);

  // Create both folders
  await provider.createDir(shortNameFolderPath);
  await provider.createDir(fullNameFolderPath);

  // Create .keep file in full name folder
  await provider.writeFile(
    provider.joinPath(fullNameFolderPath, fileNames.keepFile),
    '',
  );

  // Create [note].json
  const noteJson: NoteJson = {
    Title: title,
    CreatedAt: new Date().toISOString(),
    InternalDirs: {},
  };
  await provider.writeFile(
    provider.joinPath(shortNameFolderPath, fileNames.noteJson),
    JSON.stringify(noteJson, null, 2),
  );

  // Create [note-children].json
  const noteChildrenJson: NoteChildrenJson = { ChildNotes: {} };
  await provider.writeFile(
    provider.joinPath(shortNameFolderPath, fileNames.noteChildrenJson),
    JSON.stringify(noteChildrenJson, null, 2),
  );

  // Create initial markdown file
  const initialMd = buildInitialNoteMarkdown(title);
  await provider.writeFile(
    provider.joinPath(shortNameFolderPath, mdFileName),
    initialMd,
  );

  // Update parent's [note-children].json
  const childEntry: NoteChildEntry = {
    Title: title,
    CreatedAt: noteJson.CreatedAt,
  };
  childrenJson.ChildNotes[indexStr] = childEntry;
  await provider.writeFile(
    provider.joinPath(parentShortNameFolderPath, fileNames.noteChildrenJson),
    JSON.stringify(childrenJson, null, 2),
  );

  const notePath = parentNotePath ? `${parentNotePath}/${indexStr}` : indexStr;

  return {
    index: indexStr,
    shortNameFolderPath,
    fullNameFolderPath,
    mdFileName,
    notePath,
  };
}

/**
 * Save updated markdown content for a note.
 */
export async function saveNoteMarkdown(
  provider: IStorageProvider,
  shortNameFolderPath: string,
  mdFileName: string,
  content: string,
): Promise<void> {
  await provider.writeFile(
    provider.joinPath(shortNameFolderPath, mdFileName),
    content,
  );
}

/**
 * Rename a note: update title in [note].json, rename the full name folder,
 * rename the markdown/html/pdf files, and update the parent's [note-children].json.
 */
export async function renameNote(
  provider: IStorageProvider,
  parentShortNameFolderPath: string,
  shortNameFolderPath: string,
  oldMdFileName: string,
  newTitle: string,
): Promise<string> {
  validateTitle(newTitle);

  // Read existing note.json
  const noteJsonPath = provider.joinPath(shortNameFolderPath, fileNames.noteJson);
  const noteJsonContent = await provider.readFile(noteJsonPath);
  const noteJson: NoteJson = JSON.parse(noteJsonContent);
  const indexStr = provider.baseName(shortNameFolderPath);
  const index = parseInt(indexStr, 10);

  const oldFullName = buildFullName(index, noteJson.Title);
  const newFullName = buildFullName(index, newTitle);
  const newMdFileName = buildMdFileName(newTitle);

  // Update [note].json
  noteJson.Title = newTitle;
  await provider.writeFile(noteJsonPath, JSON.stringify(noteJson, null, 2));

  // Rename full name folder
  const oldFullFolderPath = provider.joinPath(parentShortNameFolderPath, oldFullName);
  const newFullFolderPath = provider.joinPath(parentShortNameFolderPath, newFullName);
  const oldFullExists = await provider.exists(oldFullFolderPath);
  if (oldFullExists && oldFullName !== newFullName) {
    await provider.moveDir(oldFullFolderPath, newFullFolderPath);
  }

  // Rename markdown file and derived files
  const oldHtmlFileName = buildHtmlFileName(oldMdFileName);
  const oldPdfFileName = buildPdfFileName(oldMdFileName);
  const newHtmlFileName = buildHtmlFileName(newMdFileName);
  const newPdfFileName = buildPdfFileName(newMdFileName);

  if (oldMdFileName !== newMdFileName) {
    const oldMdPath = provider.joinPath(shortNameFolderPath, oldMdFileName);
    const newMdPath = provider.joinPath(shortNameFolderPath, newMdFileName);
    if (await provider.exists(oldMdPath)) {
      await provider.moveFile(oldMdPath, newMdPath);
    }

    const oldHtmlPath = provider.joinPath(shortNameFolderPath, oldHtmlFileName);
    const newHtmlPath = provider.joinPath(shortNameFolderPath, newHtmlFileName);
    if (await provider.exists(oldHtmlPath)) {
      await provider.moveFile(oldHtmlPath, newHtmlPath);
    }

    const oldPdfPath = provider.joinPath(shortNameFolderPath, oldPdfFileName);
    const newPdfPath = provider.joinPath(shortNameFolderPath, newPdfFileName);
    if (await provider.exists(oldPdfPath)) {
      await provider.moveFile(oldPdfPath, newPdfPath);
    }
  }

  // Update parent's [note-children].json
  const parentChildrenPath = provider.joinPath(parentShortNameFolderPath, fileNames.noteChildrenJson);
  const parentChildrenContent = await provider.readFile(parentChildrenPath);
  const parentChildren: NoteChildrenJson = JSON.parse(parentChildrenContent);
  if (parentChildren.ChildNotes[indexStr]) {
    parentChildren.ChildNotes[indexStr].Title = newTitle;
    await provider.writeFile(parentChildrenPath, JSON.stringify(parentChildren, null, 2));
  }

  return newMdFileName;
}

/**
 * Delete a note and its files. Does not update parent's [note-children].json.
 * Caller should do that separately.
 */
export async function deleteNoteFiles(
  provider: IStorageProvider,
  parentShortNameFolderPath: string,
  shortName: string,
  noteTitle: string,
): Promise<void> {
  const index = parseInt(shortName, 10);
  const fullName = buildFullName(index, noteTitle);

  const shortPath = provider.joinPath(parentShortNameFolderPath, shortName);
  const fullPath = provider.joinPath(parentShortNameFolderPath, fullName);

  await provider.deleteDir(shortPath, true);
  const fullExists = await provider.exists(fullPath);
  if (fullExists) {
    await provider.deleteDir(fullPath, true);
  }
}

/**
 * Remove a child note entry from the parent's [note-children].json.
 */
export async function removeChildFromParent(
  provider: IStorageProvider,
  parentShortNameFolderPath: string,
  childIndexStr: string,
): Promise<void> {
  const childrenPath = provider.joinPath(parentShortNameFolderPath, fileNames.noteChildrenJson);
  const content = await provider.readFile(childrenPath);
  const childrenJson: NoteChildrenJson = JSON.parse(content);
  delete childrenJson.ChildNotes[childIndexStr];
  await provider.writeFile(childrenPath, JSON.stringify(childrenJson, null, 2));
}

/**
 * Update star and/or label color on a note.
 */
export async function updateNoteStarAndLabel(
  provider: IStorageProvider,
  parentShortNameFolderPath: string,
  shortNameFolderPath: string,
  starred: boolean,
  labelColor: string | null,
): Promise<void> {
  const indexStr = provider.baseName(shortNameFolderPath);

  // Update [note].json
  const noteJsonPath = provider.joinPath(shortNameFolderPath, fileNames.noteJson);
  const noteJsonContent = await provider.readFile(noteJsonPath);
  const noteJson: NoteJson = JSON.parse(noteJsonContent);
  noteJson.Starred = starred;
  noteJson.LabelColor = labelColor;
  await provider.writeFile(noteJsonPath, JSON.stringify(noteJson, null, 2));

  // Update parent [note-children].json
  const parentChildrenPath = provider.joinPath(parentShortNameFolderPath, fileNames.noteChildrenJson);
  const parentChildrenContent = await provider.readFile(parentChildrenPath);
  const parentChildren: NoteChildrenJson = JSON.parse(parentChildrenContent);
  if (parentChildren.ChildNotes[indexStr]) {
    parentChildren.ChildNotes[indexStr].Starred = starred;
    parentChildren.ChildNotes[indexStr].LabelColor = labelColor;
    await provider.writeFile(parentChildrenPath, JSON.stringify(parentChildren, null, 2));
  }
}
