/** **Custom text templates** (item 2 of the todo, "Insert custom text at the caret"): a piece of custom text
 * can be *dynamic* — `{{`/`}}` are literal `{`/`}`, `{$d:format[:offset][:T<tz>]}` is today's date/time
 * (optionally shifted, optionally rendered in a chosen timezone), `{$p}` marks where the caret should land once
 * the text is inserted, and `{name[:mode[:default[:nopersist]]]}` (any name not starting with `$`) is a "user
 * variable" — a textbox in the insertion dialog, single-line by default or `multi`line, with an optional
 * default value and an optional opt-out of persisting what was typed across sessions. Pure, no DOM/backend
 * dependency — the whole thing is a string-in, tokens-out parser plus a tokens-and-values-in, text-out
 * renderer, so both halves are plain Node-testable functions (matching this project's own "Node-tested"
 * convention for a module with no committed test file of its own yet).
 *
 * **The date format's own tokens are a deliberate near-match of what the person's own prepared format strings
 * already used** (`{$d:yyyy-MM-dd}`, `{$d:hh-mm-ss}`) — close to .NET's own custom date-and-time format
 * specifiers (`yyyy`/`MM`/`dd`/`HH`/`hh`/`mm`/`ss`/`fff`), which is why that's the convention adopted here
 * rather than inventing a third one: `yyyy`/`YYYY` (4-digit year), `MM` (month), `dd`/`DD` (day), `HH`/`hh`
 * (hour, **both 24-hour** — this module has no 12-hour/AM-PM token, since nothing asked for one and every
 * example format given was bare digits with no "tt" designator), `mm` (minute), `ss` (second), and `SSS`/
 * `fff` (millisecond, zero-padded to 3 digits — `fff` is the one to reach for; `SSS` is kept only because it
 * was there first).
 *
 * **`K`/`KK` render the *resolved* UTC offset** — not a literal the person types, a token the format can
 * *include* to show whichever offset ends up applying (the local system's own, or the explicit one from the
 * `T<tz>` segment below) — asked for directly, once `zzz` (this module's first attempt at the same idea) was
 * found to produce it unprompted even when no timezone-rendering token had actually been written: **`K`**
 * includes the colon (`+02:00`, `-05:30`) and **`KK`** omits it (`+0200`, `-0530`) — the reverse of the usual
 * "more repetition is more detail" convention, but spelled out explicitly, with worked examples, when these
 * were asked for, so it's kept exactly as given rather than "corrected" to the more familiar direction. `zzz`
 * itself is no longer a recognized token at all — it passes through as the literal three characters, the
 * same as any other text the format doesn't otherwise claim — so there is exactly one way to ask for each
 * piece: milliseconds is `fff`, the offset is `K` or `KK`, and a format combining both (`fffKK`) renders them
 * back to back with no separator of its own, e.g. `yyyy-MM-dd_hh-mm-ss-fffKK` → `2026-10-26_13-45-54-123+0200`.
 * Anything in the format string that isn't one of these tokens passes through literally, so a format can mix
 * in its own punctuation (`YYYY-MM-DD`, `DD/MM/YYYY hh:mm`).
 *
 * **The offset segment** (add/subtract date components) is `[+-]\d+` immediately followed by a unit, one or
 * more such runs concatenated with no separator (`+1y2mo3d`, `-90m`) — `y`/`d`/`h`/`m`/`s` as before, `mo` *or*
 * `M` for months (`M` added to match the person's own draft, `"-1y+2M"`, which — since offset units are
 * case-sensitive and `m` already means minutes — needed its own, distinct letter; `mo` still works too) and
 * `ms` for milliseconds. (Longer units are tried before the single-letter ones they'd otherwise be swallowed
 * by, in the regex itself — see `OFFSET_TOKEN_RE`.)
 *
 * **A timezone segment, `T<tz>`, picks which timezone the date/time is *shown* in** — a separate question
 * from the offset above (which date/time it *is*): `TZ` (the letter Z, not case-sensitive) means UTC — chosen
 * over the person's own other suggestion, `TK`, because `Z` is already the universal ISO-8601 shorthand for
 * UTC (`2024-01-01T00:00:00Z`), where `K` has no established meaning to lean on; `T+0300`/`T-0200` (always
 * exactly two digits of hours then two of minutes, no colon — matching the person's own examples) is a fixed
 * offset from UTC, applied regardless of the system's own timezone. With neither segment given, formatting
 * uses the system's own local time, exactly as before this was added. **A segment's own position among the
 * template's `:`-delimited parts doesn't matter** — `{$d:format:offset:T<tz>}` and `{$d:format:T<tz>}` (no
 * offset) both work, since every segment after the format is classified by its own shape (does it look like
 * `T<tz>`? like a valid offset?), not by which position it happens to sit in.
 *
 * **A colon inside the format (or any other segment) is written as two colons, `::`, to escape it** — item 2's
 * own ask: "give the user the option to use \[the colon] as a string literal by escaping it by repeating it; so
 * a date variable like `{$d:hh::mm:+1h}` will print something like `10:30`". The whole `$d` body is scanned
 * once, character by character (`splitDateBodySegments`): a doubled colon becomes one literal colon in whatever
 * segment is being built, and a single colon starts a new segment — so `"hh::mm:+1h"` becomes the two segments
 * `["hh:mm", "+1h"]`, the first (the format) keeping its own, real, un-escaped colon.
 *
 * **A malformed template never throws** — a `{` with no matching `}` is taken as literal text for the rest
 * of the string, a `$`-prefixed token that isn't `$d`/`$p` resolves to nothing (empty string), and a segment
 * after the format that matches neither the timezone nor the offset shape is simply dropped — none of these
 * fail the whole insertion over one typo in a custom text file the person wrote by hand. */

export interface CustomTextVariable {
  name: string
  multiline: boolean
  default: string
  /** `false` when the token ends in the literal `:nopersist` segment — this variable's typed value is never
   * remembered across sessions, even though the dialog's own state otherwise is (item 2's own "unless the
   * variable is followed by the colon with an option that prevents its value from being persisted"). */
  persist: boolean
}

/** Either UTC (`K`/`KK` render `+00:00`/`+0000`), or a fixed number of minutes offset from UTC (`K`/`KK`
 * render that offset; the displayed date/time is computed as if living at that offset, regardless of the
 * system's own timezone). `null` (the default, everywhere this type appears) means "the system's own local
 * time," exactly as this module worked before timezones existed in it at all. */
export type CustomTextTimezone = { kind: 'utc' } | { kind: 'fixed'; offsetMinutes: number }

export type CustomTextToken =
  | { kind: 'literal'; text: string }
  | { kind: 'date'; format: string; offset: string | null; timezone: CustomTextTimezone | null }
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
 * over — what `$d`'s own segment classification (below) uses to tell a genuine offset apart from anything
 * else trailing the format. */
function isValidOffset(s: string): boolean {
  if (s === '') return false
  return [...s.matchAll(OFFSET_TOKEN_RE)].map((m) => m[0]).join('') === s
}

/** `T<tz>` → UTC (`TZ`/`Tz`) or a fixed `±HHMM` offset from it (`T+0300`, `T-0200`) — or `undefined` when
 * `s` doesn't have this shape at all (so the caller can try the offset grammar instead). */
function parseTimezoneSegment(s: string): CustomTextTimezone | undefined {
  if (!/^T/i.test(s)) return undefined
  const rest = s.slice(1)
  if (/^Z$/i.test(rest)) return { kind: 'utc' }
  const m = /^([+-])(\d{2})(\d{2})$/.exec(rest)
  if (!m) return undefined
  const minutes = parseInt(m[2], 10) * 60 + parseInt(m[3], 10)
  return { kind: 'fixed', offsetMinutes: m[1] === '-' ? -minutes : minutes }
}

/** Splits the body after `"$d:"` into segments on single colons, while a *doubled* colon (`"::"`) collapses
 * to one literal colon kept inside whichever segment is currently being built — the escape item 2 asks for.
 * The first returned segment is always the format (however many colons it has of its own); the rest are
 * whatever trailing parts the template named (an offset, a timezone, or — for a malformed template — neither,
 * simply dropped later on). */
function splitDateBodySegments(body: string): string[] {
  const segments: string[] = []
  let current = ''
  let i = 0
  while (i < body.length) {
    if (body[i] === ':' && body[i + 1] === ':') {
      current += ':'
      i += 2
      continue
    }
    if (body[i] === ':') {
      segments.push(current)
      current = ''
      i++
      continue
    }
    current += body[i]
    i++
  }
  segments.push(current)
  return segments
}

function parseToken(body: string): CustomTextToken {
  if (body === '$p') return { kind: 'caret' }
  if (body.startsWith('$d')) {
    const segments = splitDateBodySegments(body.slice(2).replace(/^:/, ''))
    const format = segments[0] ?? ''
    let offset: string | null = null
    let timezone: CustomTextTimezone | null = null
    for (const segment of segments.slice(1)) {
      const tz = parseTimezoneSegment(segment)
      if (tz) {
        timezone = tz
        continue
      }
      if (isValidOffset(segment)) offset = segment
      // anything else trailing the format is dropped — a malformed template never throws.
    }
    return { kind: 'date', format, offset, timezone }
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

// `KK` is listed ahead of `K` — the same "longer run before the single letter it would otherwise swallow"
// rule `OFFSET_TOKEN_RE`'s own `mo`/`ms` already follow — so a format's own "KK" is read as one token, not
// two separate "K"s in a row. `zzz` is deliberately absent: it isn't a token any more, so it's left for the
// `default` branch below (which never actually sees it, since this regex is what `.replace` scans the format
// with in the first place) — in practice it just means "zzz" never matches here and passes through literally.
const DATE_TOKEN_RE = /YYYY|yyyy|MM|DD|dd|HH|hh|mm|ss|SSS|fff|KK|K/g

/** `date`'s own field values, read for whichever timezone is in effect — `null` (the system's local time,
 * via the plain getters) or a resolved utc/fixed one (via a timestamp shifted by the chosen offset, read back
 * with the UTC getters, the standard trick for "what would the wall clock read at this other offset"). Also
 * carries the *effective* offset in minutes, which is what the `K`/`KK` tokens themselves render. */
function displayParts(date: Date, timezone: CustomTextTimezone | null) {
  if (timezone === null) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hours: date.getHours(),
      minutes: date.getMinutes(),
      seconds: date.getSeconds(),
      millis: date.getMilliseconds(),
      offsetMinutes: -date.getTimezoneOffset(),
    }
  }
  const offsetMinutes = timezone.kind === 'utc' ? 0 : timezone.offsetMinutes
  const shifted = new Date(date.getTime() + offsetMinutes * 60000)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
    seconds: shifted.getUTCSeconds(),
    millis: shifted.getUTCMilliseconds(),
    offsetMinutes,
  }
}

function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+'
  const abs = Math.abs(offsetMinutes)
  const hh = String(Math.floor(abs / 60)).padStart(2, '0')
  const mm = String(abs % 60).padStart(2, '0')
  return `${sign}${hh}:${mm}`
}

// `KK`'s own, colon-free sibling — kept as a second, separate function rather than a parameter on
// `formatOffset` so each token's own formatter stays a one-line, obviously-correct lookup in the switch below.
function formatOffsetNoColon(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+'
  const abs = Math.abs(offsetMinutes)
  const hh = String(Math.floor(abs / 60)).padStart(2, '0')
  const mm = String(abs % 60).padStart(2, '0')
  return `${sign}${hh}${mm}`
}

function formatDate(date: Date, format: string, timezone: CustomTextTimezone | null): string {
  const parts = displayParts(date, timezone)
  return format.replace(DATE_TOKEN_RE, (token) => {
    switch (token) {
      case 'YYYY':
      case 'yyyy':
        return String(parts.year).padStart(4, '0')
      case 'MM':
        return String(parts.month).padStart(2, '0')
      case 'DD':
      case 'dd':
        return String(parts.day).padStart(2, '0')
      case 'HH':
      case 'hh':
        return String(parts.hours).padStart(2, '0')
      case 'mm':
        return String(parts.minutes).padStart(2, '0')
      case 'ss':
        return String(parts.seconds).padStart(2, '0')
      case 'SSS':
      case 'fff':
        return String(parts.millis).padStart(3, '0')
      case 'K':
        return formatOffset(parts.offsetMinutes)
      case 'KK':
        return formatOffsetNoColon(parts.offsetMinutes)
      default:
        return token
    }
  })
}

// Longer units (`mo`, `ms`) are listed ahead of the single-letter ones they'd otherwise be swallowed by —
// regex alternation takes the *first* alternative that matches at a position, not the longest, so `mo`/`ms`
// must come before `m`/`s` or "+5ms" would wrongly read as "+5m" followed by a dangling, ignored "s". `M`
// (month, uppercase — added alongside the pre-existing `mo`) is a distinct literal from lowercase `m`
// (minute), so the two never collide.
const OFFSET_TOKEN_RE = /([+-]\d+)(y|mo|M|ms|d|h|m|s)/g

function applyOffset(date: Date, offset: string): Date {
  const result = new Date(date.getTime())
  for (const m of offset.matchAll(OFFSET_TOKEN_RE)) {
    const amount = parseInt(m[1], 10)
    switch (m[2]) {
      case 'y':
        result.setFullYear(result.getFullYear() + amount)
        break
      case 'mo':
      case 'M':
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
    else if (token.kind === 'date') text += formatDate(token.offset ? applyOffset(now, token.offset) : now, token.format, token.timezone)
    else text += values[token.variable.name] ?? token.variable.default
  }
  return { text, caretOffset }
}
