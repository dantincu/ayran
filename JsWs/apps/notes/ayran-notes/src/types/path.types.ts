export enum AyranPathType {
  /** ||/<note-path> — note absolute from notebook root */
  NoteAbsolute = 'note-absolute',
  /** ||./<note-path> — note relative to current note */
  NoteRelative = 'note-relative',
  /** |/<file-path> — file absolute from notebook root */
  FileAbsolute = 'file-absolute',
  /** |./<file-path> — file relative to current directory */
  FileRelative = 'file-relative',
  /** ||/<note-path>/|/<file-path> — file attached to a specific note */
  NoteFile = 'note-file',
  /** Plain relative path (no | prefix) */
  PlainRelative = 'plain-relative',
  /** External URI */
  External = 'external',
}

export interface ParsedAyranPath {
  type: AyranPathType;
  raw: string;
  notePath?: string;
  filePath?: string;
  /** True if note path is relative (||./) */
  noteRelative?: boolean;
  /** True if file path is relative (|./) */
  fileRelative?: boolean;
}

export interface ResolvedPath {
  /** The actual storage path (absolute on the storage provider) */
  storagePath: string;
  /** Whether this resolves to a note or a file/folder */
  isNote: boolean;
}
