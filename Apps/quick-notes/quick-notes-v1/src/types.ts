export interface NoteLabel {
  id: string;
  text: string;
  /** Hex color, e.g. "#1c1a22". Undefined means the theme default (dark text on light background). */
  fg?: string;
  bg?: string;
}

export interface Note {
  id: string;
  /** Derived from the note's primary markdown heading, recomputed on every save. Empty string means untitled. */
  title: string;
  /** Raw markdown source. */
  content: string;
  createdAt: number;
  updatedAt: number;
  labels: NoteLabel[];
  /** IDs of Stylesheet records applied to this note's raw markdown editor. */
  editorStylesheetIds: string[];
  /** IDs of Stylesheet records applied to this note's rendered preview. */
  previewStylesheetIds: string[];
  /** Position in the user's custom note order (lower sorts first). Only consulted when ListSettings.orderMode is 'custom'. */
  order: number;
}

export interface Stylesheet {
  id: string;
  name: string;
  cssText: string;
  /** Built-in stylesheets are read-only and non-deletable, but can be cloned. */
  builtin: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface NoteTemplate {
  id: string;
  name: string;
  editorStylesheetIds: string[];
  previewStylesheetIds: string[];
  createdAt: number;
}

/** Global (not per-note) preferences for the raw-markdown editor. */
export interface EditorSettings {
  wrapText: boolean;
  highlightWhitespace: boolean;
}

/** Global preferences for the notes list. */
export interface ListSettings {
  /** 'default' = last created first. 'custom' = user-arranged via drag/arrows, see Note.order. */
  orderMode: 'default' | 'custom';
}
