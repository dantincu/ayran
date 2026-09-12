export interface Note {
  id: string;
  /** Derived from the note's primary markdown heading, recomputed on every save. Empty string means untitled. */
  title: string;
  /** Raw markdown source. */
  content: string;
  createdAt: number;
  updatedAt: number;
}
