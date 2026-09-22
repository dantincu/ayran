import raw from '../../config/folder-pairs-and-notes.json'

/** **The constants of the folder pairs and the notes**: `config/folder-pairs-and-notes.json`, the one file both sides read — this
 * page bundles it, the Rust backend embeds it (`src-tauri/src/config.rs`, which also checks it). It is inside every installer and
 * APK and cannot be changed on a person's machine; to change a constant, edit the file and rebuild. */

/** A numbering as the file writes it: a prefix, an interval (`from` → `to`, the direction being which is larger), how many digits an
 * index has, and how a new pair chooses its index. */
export interface NumberingDef {
  label: string
  prefix: string
  from: number
  to: number
  digits: number
  indexing: 'fillGaps' | 'afterLargest'
  /** An internals' pair: the fixed part of its full folder's name. */
  name?: string
}

interface AppConfig {
  folderPairs: {
    keepFile: string
    keepContent: string
    temporaryPrefix: string
    maxNamePartChars: number
    accountProvider: string
    defaultNumbering: NumberingDef
  }
  notes: {
    files: { notebook: string; note: string; children: string; userAction: string }
    markdown: { prefix: string; suffix: string }
    numberings: { noteItems: NumberingDef; primarySections: NumberingDef; secondarySections: NumberingDef; ternarySections: NumberingDef }
    internals: { noteFiles: NumberingDef; noteInternals: NumberingDef; notebook: NumberingDef }
  }
}

export const config = raw as unknown as AppConfig

// The folder pairs
export const KEEP_FILE = config.folderPairs.keepFile
export const KEEP_CONTENT = config.folderPairs.keepContent
export const TEMPORARY_PREFIX = config.folderPairs.temporaryPrefix
export const MAX_NAME_PART_CHARS = config.folderPairs.maxNamePartChars

// The notes' files and names
export const NOTEBOOK_FILE = config.notes.files.notebook
export const NOTE_JSON = config.notes.files.note
export const CHILDREN_JSON = config.notes.files.children
/** The file in the notebook's own internals folder (`03`) that names the page of its User Action. */
export const USER_ACTION_JSON = config.notes.files.userAction
export const MARKDOWN_PREFIX = config.notes.markdown.prefix
export const NOTE_MARKDOWN_SUFFIX = config.notes.markdown.suffix
