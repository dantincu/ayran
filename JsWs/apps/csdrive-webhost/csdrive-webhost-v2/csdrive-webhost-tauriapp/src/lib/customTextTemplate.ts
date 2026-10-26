/** **Custom text templates** (item 2 of the todo, "Insert custom text at the caret"): a piece of custom text
 * can be *dynamic* — `{{`/`}}` are literal `{`/`}`, `{$d:format[:offset]}` is today's date/time (optionally
 * shifted), `{$p}` marks where the caret should land once the text is inserted, and `{name[:mode[:default
 * [:nopersist]]]}` (any name not starting with `$`) is a "user variable" — a textbox in the insertion dialog,
 * single-line by default or `multi`line, with an optional default value and an optional opt-out of persisting
 * what was typed across sessions. Pure, no DOM/backend dependency — the whole thing is a string-in,
 * tokens-out parser plus a tokens-and-values-in, text-out renderer, so both halves are plain Node-testable
 * functions (matching this project's own "Node-tested" convention for a module with no committed test file
 * of its own yet).
 *
 * **The date format's own tokens and the offset's own syntax are this module's own design choice, not
 * something the spec pinned down precisely** — the person asked for "year, month, day, hour, minutes,
 * seconds, millis" to be choosable and for the offset to "add or subtract from... now," without naming an
 * exact token/offset grammar. Chosen here: the same repeated-letter convention common date-formatting
 * libraries (moment/day.js) already use — `YYYY`/`MM`/`DD`/`hh`/`mm`/`ss`/`SSS` — and an offset as one or more
 * `<sign><number><unit>` runs concatenated with no separator (`+1y2mo3d`, `-90m`), units being `y`/`mo`/`d`/
 * `h`/`m`/`s`/`ms`. Anything in the format string that isn't one of the seven tokens passes through literally
 * (so a format can mix in its own punctuation — `YYYY-MM-DD`, `DD/MM/YYYY hh:mm`).
 *
 * **A malformed template never throws** — a `{` with no matching `}` is taken as literal text for the rest
 * of the string, and a `$`-prefixed token that isn't `$d`/`$p` resolves to nothing (empty string) rather than
 * failing the whole insertion over one typo in a custom text file the person wrote by hand. */

export interface CustomTextVariable {
  name: string
  multiline: boolean
  default: string
  /** `false` when the token ends in the literal `:nopersist` segment — this variable's typed value is never
   * remembered across sessions, even though the dialog's own state otherwise is (item 2's own "unless the
   * variable is followed by the colon with an option that prevents its value from being persisted"). */
  persist: boolean
}

export type CustomTextToken =
  | { kind: 'literal'; text: string }
  | { kind: 'date'; format: string; offset: string | null }
  | { kind: 'caret' }
  | { kind: 'variable'; variable: CustomTextVariable }

/** The first two `:`-delimited segments of a user variable's own body are *positional* (`name`, then its
 * line-mode) — but everything after that is a single `default` value that may itself contain colons (a time
 * string, say), so it's never split further by position. Only a genuine trailing `:nopersist` (peeled from
 * the *end* of that remainder, case-insensitively, mirroring how `$d`'s own trailing offset is found below)
 * opts it out of persistence; a remainder that merely happens to *contain* the word "nopersist" somewhere in
 * the middle, or that *is* "nopersist" with no colon in front of it to separate it from the mode, is just
 * ordinary default text. */
function splitVariableBody(body: string): { name: string; mode: string; rest: string } {
  const firstColon = body.indexOf(':')
  if (firstColon === -1) return { name: body, mode: '', rest: '' }
  const name = body.slice(0, firstColon)
  const afterName = body.slice(firstColon + 1)
  const secondColon = afterName.indexOf(':')
  if (secondColon === -1) return { name, mode: afterName, rest: '' }
  return { name, mode: afterName.slice(0, secondColon), rest: afterName.slice(secondColon + 1) }
}

/** `true` when `s` is made up entirely of one or more valid offset tokens, back to back, with nothing left
 * over — what `$d`'s own trailing-offset detection (below) uses to tell a genuine offset apart from a date
 * format that simply happens to end in something colon-separated (`hh:mm`'s own "mm" doesn't match). */
function isValidOffset(s: string): boolean {
  if (s === '') return false
  return [...s.matchAll(OFFSET_TOKEN_RE)].map((m) => m[0]).join('') === s
}

function parseToken(body: string): CustomTextToken {
  if (body === '$p') return { kind: 'caret' }
  if (body.startsWith('$d')) {
    const afterColon = body.slice(2).replace(/^:/, '')
    const lastColon = afterColon.lastIndexOf(':')
    const candidate = lastColon === -1 ? '' : afterColon.slice(lastColon + 1)
    if (lastColon !== -1 && isValidOffset(candidate)) return { kind: 'date', format: afterColon.slice(0, lastColon), offset: candidate }
    return { kind: 'date', format: afterColon, offset: null }
  }
  if (body.startsWith('$')) return { kind: 'literal', text: '' } // an unrecognized $-token: a template typo, not a crash.
  const { name, mode, rest } = splitVariableBody(body)
  const lastColon = rest.lastIndexOf(':')
  const persist = !(lastColon !== -1 && rest.slice(lastColon + 1).toLowerCase() === 'nopersist')
  return {
    kind: 'variable',
    variable: {
      name,
      multiline: mode.toLowerCase() === 'multi' || mode.toLowerCase() === 'multiline',
      default: persist ? rest : rest.slice(0, lastColon),
      persist,
    },
  }
}

/** Turns a template string into a flat list of tokens — literal runs, the date token, the caret-pointer
 * token, and user-variable tokens — in document order. */
export function parseCustomTextTemplate(template: string): CustomTextToken[] {
  const tokens: CustomTextToken[] = []
  let literal = ''
  let i = 0
  const flush = () => {
    if (literal) tokens.push({ kind: 'literal', text: literal })
    literal = ''
  }
  while (i < template.length) {
    const c = template[i]
    if (c === '{' && template[i + 1] === '{') {
      literal += '{'
      i += 2
      continue
    }
    if (c === '}' && template[i + 1] === '}') {
      literal += '}'
      i += 2
      continue
    }
    if (c === '{') {
      const end = template.indexOf('}', i + 1)
      if (end === -1) {
        literal += template.slice(i)
        i = template.length
        continue
      }
      flush()
      tokens.push(parseToken(template.slice(i + 1, end)))
      i = end + 1
      continue
    }
    literal += c
    i++
  }
  flush()
  return tokens
}

/** The distinct user variables a template asks for, in the order they first appear — what the insertion
 * dialog builds its textboxes from. A name repeated later in the same template reuses the *first* mention's
 * own mode/default/persist (consistent with there being exactly one textbox per name, not one per mention). */
export function templateVariables(tokens: CustomTextToken[]): CustomTextVariable[] {
  const seen = new Map<string, CustomTextVariable>()
  for (const token of tokens) {
    if (token.kind === 'variable' && !seen.has(token.variable.name)) seen.set(token.variable.name, token.variable)
  }
  return [...seen.values()]
}

const DATE_TOKEN_RE = /YYYY|MM|DD|hh|mm|ss|SSS/g

function formatDate(date: Date, format: string): string {
  return format.replace(DATE_TOKEN_RE, (token) => {
    switch (token) {
      case 'YYYY':
        return String(date.getFullYear()).padStart(4, '0')
      case 'MM':
        return String(date.getMonth() + 1).padStart(2, '0')
      case 'DD':
        return String(date.getDate()).padStart(2, '0')
      case 'hh':
        return String(date.getHours()).padStart(2, '0')
      case 'mm':
        return String(date.getMinutes()).padStart(2, '0')
      case 'ss':
        return String(date.getSeconds()).padStart(2, '0')
      case 'SSS':
        return String(date.getMilliseconds()).padStart(3, '0')
      default:
        return token
    }
  })
}

// Longer units (`mo`, `ms`) are listed ahead of the single-letter ones they'd otherwise be swallowed by —
// regex alternation takes the *first* alternative that matches at a position, not the longest, so `mo`/`ms`
// must come before `m`/`s` or "+5ms" would wrongly read as "+5m" followed by a dangling, ignored "s".
const OFFSET_TOKEN_RE = /([+-]\d+)(y|mo|ms|d|h|m|s)/g

function applyOffset(date: Date, offset: string): Date {
  const result = new Date(date.getTime())
  for (const m of offset.matchAll(OFFSET_TOKEN_RE)) {
    const amount = parseInt(m[1], 10)
    switch (m[2]) {
      case 'y':
        result.setFullYear(result.getFullYear() + amount)
        break
      case 'mo':
        result.setMonth(result.getMonth() + amount)
        break
      case 'd':
        result.setDate(result.getDate() + amount)
        break
      case 'h':
        result.setHours(result.getHours() + amount)
        break
      case 'm':
        result.setMinutes(result.getMinutes() + amount)
        break
      case 's':
        result.setSeconds(result.getSeconds() + amount)
        break
      case 'ms':
        result.setMilliseconds(result.getMilliseconds() + amount)
        break
    }
  }
  return result
}

export interface CustomTextRenderResult {
  text: string
  /** Where `{$p}` landed in `text` (character offset), or `null` when the template had none — the caller
   * then just places the caret at the end of the inserted text, the same as typing it normally would. */
  caretOffset: number | null
}

/** Resolves every token except the literal runs (already text) against `values` (the user variables'
 * current textbox contents) and `now` (real time by default; a fixed value makes this deterministic for a
 * test). A variable with nothing typed yet falls back to its own default. */
export function renderCustomTextTemplate(tokens: CustomTextToken[], values: Record<string, string>, now: Date = new Date()): CustomTextRenderResult {
  let text = ''
  let caretOffset: number | null = null
  for (const token of tokens) {
    if (token.kind === 'literal') text += token.text
    else if (token.kind === 'caret') caretOffset = text.length
    else if (token.kind === 'date') text += formatDate(token.offset ? applyOffset(now, token.offset) : now, token.format)
    else text += values[token.variable.name] ?? token.variable.default
  }
  return { text, caretOffset }
}
