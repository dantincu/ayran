import type { Stylesheet } from '../types';

export const BUILTIN_EDITOR_HIGHLIGHT_ID = 'builtin-editor-highlight';
export const BUILTIN_PREVIEW_TYPOGRAPHY_ID = 'builtin-preview-typography';
export const BUILTIN_PREVIEW_CODE_HIGHLIGHT_ID = 'builtin-preview-code-highlight';

export const DEFAULT_EDITOR_STYLESHEET_IDS = [BUILTIN_EDITOR_HIGHLIGHT_ID];
export const DEFAULT_PREVIEW_STYLESHEET_IDS = [BUILTIN_PREVIEW_TYPOGRAPHY_ID, BUILTIN_PREVIEW_CODE_HIGHLIGHT_ID];

const EDITOR_HIGHLIGHT_CSS = `/* Raw markdown source highlighting (block-level) */

.md-heading {
  color: var(--accent);
  font-weight: 700;
}

.md-code {
  color: var(--code-string);
}

.md-list {
  color: var(--code-number);
}

.md-quote {
  color: var(--text-muted);
  font-style: italic;
}

.md-rule {
  color: var(--border-strong);
}

.md-table {
  color: var(--code-title);
}
`;

const PREVIEW_TYPOGRAPHY_CSS = `.note-editor-preview h1,
.note-editor-preview h2,
.note-editor-preview h3,
.note-editor-preview h4,
.note-editor-preview h5,
.note-editor-preview h6 {
  margin: 1.4em 0 0.5em;
  font-weight: 700;
  line-height: 1.3;
  color: var(--text);
}

.note-editor-preview h1 {
  font-size: 1.7em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--border);
}

.note-editor-preview h2 {
  font-size: 1.4em;
  padding-bottom: 0.25em;
  border-bottom: 1px solid var(--border);
}

.note-editor-preview h3 {
  font-size: 1.2em;
}

.note-editor-preview h4 {
  font-size: 1.05em;
}

.note-editor-preview h5,
.note-editor-preview h6 {
  font-size: 0.95em;
  color: var(--text-muted);
}

.note-editor-preview p {
  margin: 0.7em 0;
}

.note-editor-preview a {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.note-editor-preview strong {
  font-weight: 700;
}

.note-editor-preview em {
  font-style: italic;
}

.note-editor-preview del {
  color: var(--text-muted);
}

.note-editor-preview hr {
  margin: 1.6em 0;
  border: none;
  border-top: 1px solid var(--border);
}

.note-editor-preview img {
  max-width: 100%;
  border-radius: 8px;
}

.note-editor-preview ul,
.note-editor-preview ol {
  margin: 0.7em 0;
  padding-left: 1.6em;
}

.note-editor-preview li {
  margin: 0.25em 0;
}

.note-editor-preview li > ul,
.note-editor-preview li > ol {
  margin: 0.25em 0;
}

.note-editor-preview li:has(> input[type='checkbox']) {
  list-style: none;
  margin-left: -1.6em;
}

.note-editor-preview input[type='checkbox'] {
  margin-right: 0.5em;
}

.note-editor-preview pre {
  background: var(--hover);
  padding: 12px 14px;
  border-radius: 8px;
  overflow-x: auto;
  margin: 0.8em 0;
}

.note-editor-preview code {
  background: var(--hover);
  padding: 0.1em 0.35em;
  border-radius: 4px;
  font-size: 0.9em;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
}

.note-editor-preview pre code {
  background: none;
  padding: 0;
  font-size: 0.85em;
  line-height: 1.55;
}

.note-editor-preview blockquote {
  margin: 0.8em 0;
  padding: 2px 14px;
  border-left: 3px solid var(--border-strong);
  color: var(--text-muted);
}

.note-editor-preview table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.8em 0;
}

.note-editor-preview th {
  background: var(--hover);
  font-weight: 700;
}

.note-editor-preview th,
.note-editor-preview td {
  border: 1px solid var(--border);
  padding: 6px 10px;
  text-align: left;
}
`;

const PREVIEW_CODE_HIGHLIGHT_CSS = `/* Syntax highlighting (rehype-highlight / highlight.js token classes) */

.note-editor-preview .hljs-comment,
.note-editor-preview .hljs-quote {
  color: var(--text-muted);
  font-style: italic;
}

.note-editor-preview .hljs-keyword,
.note-editor-preview .hljs-selector-tag,
.note-editor-preview .hljs-subst,
.note-editor-preview .hljs-doctag {
  color: var(--code-keyword);
}

.note-editor-preview .hljs-string,
.note-editor-preview .hljs-regexp,
.note-editor-preview .hljs-addition {
  color: var(--code-string);
}

.note-editor-preview .hljs-number,
.note-editor-preview .hljs-literal,
.note-editor-preview .hljs-symbol,
.note-editor-preview .hljs-attr {
  color: var(--code-number);
}

.note-editor-preview .hljs-title,
.note-editor-preview .hljs-section,
.note-editor-preview .hljs-selector-id,
.note-editor-preview .hljs-selector-class,
.note-editor-preview .hljs-selector-pseudo {
  color: var(--code-title);
}

.note-editor-preview .hljs-attribute {
  color: var(--code-keyword);
}

.note-editor-preview .hljs-meta {
  color: var(--code-tag);
}

.note-editor-preview .hljs-tag,
.note-editor-preview .hljs-name {
  color: var(--code-tag);
}

.note-editor-preview .hljs-built_in,
.note-editor-preview .hljs-builtin-name,
.note-editor-preview .hljs-type {
  color: var(--code-builtin);
}

.note-editor-preview .hljs-deletion {
  color: #dc2626;
}

.note-editor-preview .hljs-emphasis {
  font-style: italic;
}

.note-editor-preview .hljs-strong {
  font-weight: 700;
}
`;

/** Content (never `id`/`builtin`/timestamps) is re-applied on every DB open, so app updates to these propagate to existing installs. */
export const DEFAULT_STYLESHEETS: Array<Pick<Stylesheet, 'id' | 'name' | 'cssText'>> = [
  { id: BUILTIN_EDITOR_HIGHLIGHT_ID, name: 'Editor: block highlighting', cssText: EDITOR_HIGHLIGHT_CSS },
  { id: BUILTIN_PREVIEW_TYPOGRAPHY_ID, name: 'Preview: typography', cssText: PREVIEW_TYPOGRAPHY_CSS },
  { id: BUILTIN_PREVIEW_CODE_HIGHLIGHT_ID, name: 'Preview: code highlighting', cssText: PREVIEW_CODE_HIGHLIGHT_CSS },
];
