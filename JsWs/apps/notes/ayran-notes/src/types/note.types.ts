export enum NoteInternalDir {
  Root = 1,
  Internals = 2,
  Files = 3,
}

export type NoteCategory = 'regular' | 'primary' | 'secondary' | 'ternary';

export interface NoteJson {
  Title: string;
  CreatedAt: string; // ISO UTC timestamp
  InternalDirs?: Record<string, NoteInternalDir>;
  Starred?: boolean;
  LabelColor?: string | null;
}

export interface NoteChildEntry {
  Title: string;
  CreatedAt: string;
  Starred?: boolean;
  LabelColor?: string | null;
}

export interface NoteChildrenJson {
  ChildNotes: Record<string, NoteChildEntry>; // key = note index string e.g. "999"
}

export interface NotePaths {
  /** 3-digit index as string, e.g. "999" */
  index: string;
  /** Short name folder: just the 3 digits */
  shortName: string;
  /** Full name folder: "{index}-{sanitized-title}" */
  fullName: string;
  /** Markdown file name: "0-{sanitized-title}[note].md" */
  mdFileName: string;
  /** HTML file name: mdFileName + ".html" */
  htmlFileName: string;
  /** PDF file name: mdFileName + ".pdf" */
  pdfFileName: string;
}

export interface NoteMetadata {
  index: string;
  title: string;
  createdAt: string;
  starred: boolean;
  labelColor: string | null;
  /** Path of note relative to notebook root, e.g. "999/998" (parent/child indexes) */
  notePath: string;
}

export interface NoteIndexRange {
  max: number;
  min: number;
  label: string;
  maxCount: number;
}
