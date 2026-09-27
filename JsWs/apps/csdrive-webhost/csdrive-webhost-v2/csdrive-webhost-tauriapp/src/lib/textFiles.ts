/** Deciding whether a file is text worth editing, and reading it safely if so — shared by the Files tab and Notes'
 * File Manager / Note Files Explorer, so the two behave the same way (see CLAUDE.md's Follow-up notes: clicking a
 * file used to always try to open it as text, whatever its extension — a binary file either silently showed
 * replacement characters (`TextDecoder` with no `fatal` option never throws) or, worse, was reported by a
 * size-based message that had nothing to do with why it couldn't really be opened). */

/** A file bigger than this isn't read into the editor at all — export it instead. */
export const MAX_EDIT_BYTES = 2 * 1024 * 1024

/** Extensions that **default** to opening in the text editor on a plain click — everything else still *can* be
 * edited as text ("Edit as text" is offered for any file), it just isn't assumed to be text until asked. Kept
 * intentionally broad (common programming and config languages), not just the ones `lib/highlight.ts` can
 * colour — a `.py` file is still text worth a default double-click, even with no syntax highlighting for it yet. */
const DEFAULT_TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'mdown',
  'mkd',
  'html',
  'htm',
  'xhtml',
  'css',
  'scss',
  'less',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'tsx',
  'json',
  'jsonc',
  'json5',
  'yaml',
  'yml',
  'toml',
  'xml',
  'svg',
  'ini',
  'conf',
  'cfg',
  'env',
  'gitignore',
  'editorconfig',
  'py',
  'rb',
  'php',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'cs',
  'swift',
  'dart',
  'lua',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'bat',
  'cmd',
  'sql',
  'graphql',
  'vue',
  'log',
  'csv',
])

/** Whether `name`'s extension is one that defaults to opening in the text editor. */
export function isDefaultTextFile(name: string): boolean {
  const dot = name.lastIndexOf('.')
  const extension = (dot < 0 ? name : name.slice(dot + 1)).toLowerCase()
  return DEFAULT_TEXT_EXTENSIONS.has(extension)
}

/** The file's text, or `null` if it isn't text (or is too big to edit here): too large, has a NUL byte in its
 * first 8000 bytes (the same sniff `docs`' searching uses for "can this be searched as text"), or isn't valid
 * UTF-8 (`TextDecoder`'s `fatal` option — its default, `false`, silently replaces bad bytes with U+FFFD instead
 * of telling the caller anything went wrong, which is how a genuinely binary file used to show as garbled text
 * rather than being refused). */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.length > MAX_EDIT_BYTES || bytes.subarray(0, 8000).includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/** The message to show when a file's extension isn't a recognized text one and opening it as text wasn't asked
 * for explicitly — offering the escape hatch by name, since the option really is there. */
export function notDefaultTextMessage(name: string): string {
  return `"${name}" isn't a recognized text file — use "Edit as text" to open it anyway, or export it.`
}
