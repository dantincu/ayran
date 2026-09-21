/** JavaScript and CSS for `lib/highlight.ts`: the same contract — the result is HTML whose text content is exactly the input,
 * with `<span class="tok-…">` around what is worth colouring. Small forgiving scanners, not parsers. */

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
const esc = (text: string) => text.replace(/[&<>]/g, (c) => ESCAPES[c])
const span = (kind: string, text: string) => (text === '' ? '' : `<span class="tok-${kind}">${esc(text)}</span>`)

// ── JavaScript ────────────────────────────────────────────────────────────────

const KEYWORDS = new Set(
  (
    'as async await break case catch class const continue debugger default delete do else enum export extends finally for from function get if ' +
    'implements import in instanceof interface let new of package private protected public return set static super switch this throw try ' +
    'typeof var void while with yield'
  ).split(' '),
)
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'])

const LINE_COMMENT = /\/\/[^\n]*/y
const BLOCK_COMMENT = /\/\*[\s\S]*?(?:\*\/|$)/y
const SINGLE_STRING = /'(?:\\[\s\S]|[^'\\\n])*'?/y
const DOUBLE_STRING = /"(?:\\[\s\S]|[^"\\\n])*"?/y
const TEMPLATE = /`(?:\\[\s\S]|[^`\\])*`?/y
const REGEX_LITERAL = /\/(?![*/])(?:\\.|[^/\\\n[]|\[(?:\\.|[^\]\\\n])*\])+\/[a-z]*/y
const NUMBER = /0[xX][\da-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?n?/y
const IDENTIFIER = /[A-Za-z_$ -￿][\w$ -￿]*/y

function matchAt(pattern: RegExp, text: string, at: number): string | null {
  pattern.lastIndex = at
  const m = pattern.exec(text)
  return m && m[0] !== '' ? m[0] : null
}

export function highlightJavaScript(text: string): string {
  let out = ''
  let i = 0
  let plain = ''
  // Whether a `/` here can begin a regular expression: not after a value (a name, a number, a closing bracket).
  let valueBefore = false
  const flush = () => {
    if (plain !== '') out += esc(plain)
    plain = ''
  }
  const emit = (kind: string, token: string) => {
    flush()
    out += span(kind, token)
    i += token.length
  }
  while (i < text.length) {
    const ch = text[i]
    if (/\s/.test(ch)) {
      plain += ch
      i++
      continue
    }
    let token: string | null
    if (ch === '/' && (token = matchAt(LINE_COMMENT, text, i))) emit('comment', token)
    else if (ch === '/' && (token = matchAt(BLOCK_COMMENT, text, i))) emit('comment', token)
    else if (ch === "'" && (token = matchAt(SINGLE_STRING, text, i))) {
      emit('string', token)
      valueBefore = true
    } else if (ch === '"' && (token = matchAt(DOUBLE_STRING, text, i))) {
      emit('string', token)
      valueBefore = true
    } else if (ch === '`' && (token = matchAt(TEMPLATE, text, i))) {
      emit('string', token)
      valueBefore = true
    } else if (ch === '/' && !valueBefore && (token = matchAt(REGEX_LITERAL, text, i))) {
      emit('regex', token)
      valueBefore = true
    } else if ((/\d/.test(ch) || (ch === '.' && /\d/.test(text[i + 1] ?? ''))) && (token = matchAt(NUMBER, text, i))) {
      emit('number', token)
      valueBefore = true
    } else if ((token = matchAt(IDENTIFIER, text, i))) {
      // A name followed by "(" is a call (or a definition); words the language owns are keywords.
      const next = /^\s*\(/.test(text.slice(i + token.length, i + token.length + 40))
      if (KEYWORDS.has(token)) {
        emit('keyword', token)
        valueBefore = token === 'this' || token === 'super'
      } else if (LITERALS.has(token)) {
        emit('literal', token)
        valueBefore = true
      } else {
        if (next) emit('function', token)
        else {
          plain += token // a plain name is left uncoloured
          i += token.length
        }
        valueBefore = true
      }
    } else {
      plain += ch
      i++
      valueBefore = ch === ')' || ch === ']' || ch === '}'
    }
  }
  flush()
  return out
}

// ── CSS ───────────────────────────────────────────────────────────────────────

const CSS_COMMENT = /\/\*[\s\S]*?(?:\*\/|$)/y
const CSS_STRING = /"(?:\\[\s\S]|[^"\\\n])*"?|'(?:\\[\s\S]|[^'\\\n])*'?/y

/** Where the statement that begins at `from` ends, and how: a block opens (`{`), or a declaration/at-rule ends (`;` or `}`) —
 * looking past strings, comments and brackets. */
function statementEnd(text: string, from: number): { at: number; opens: boolean } {
  let depth = 0
  for (let i = from; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"' || ch === "'") {
      const s = matchAt(CSS_STRING, text, i)
      if (s) i += s.length - 1
    } else if (ch === '/' && text[i + 1] === '*') {
      const c = matchAt(CSS_COMMENT, text, i)
      if (c) i += c.length - 1
    } else if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
    else if (depth === 0 && (ch === '{' || ch === ';' || ch === '}')) return { at: i, opens: ch === '{' }
  }
  return { at: text.length, opens: false }
}

/** A selector (or an at-rule's prelude): `.class`, `#id`, `:pseudo`, `[attr]`, tag names. */
function cssSelector(segment: string): string {
  let out = ''
  let i = 0
  let plain = ''
  const flush = () => {
    if (plain !== '') out += esc(plain)
    plain = ''
  }
  while (i < segment.length) {
    const rest = segment.slice(i)
    let m: RegExpExecArray | null
    if ((m = /^\/\*[\s\S]*?(?:\*\/|$)/.exec(rest))) {
      flush()
      out += span('comment', m[0])
    } else if ((m = /^@[\w-]+/.exec(rest))) {
      flush()
      out += span('atrule', m[0])
    } else if ((m = /^"(?:\\[\s\S]|[^"\\\n])*"?|^'(?:\\[\s\S]|[^'\\\n])*'?/.exec(rest))) {
      flush()
      out += span('string', m[0])
    } else if ((m = /^[.#][\w-]+/.exec(rest))) {
      flush()
      out += span('selector', m[0])
    } else if ((m = /^::?[\w-]+/.exec(rest))) {
      flush()
      out += span('atrule', m[0])
    } else if ((m = /^\[[^\]\n]*\]?/.exec(rest))) {
      flush()
      out += span('attr', m[0])
    } else if ((m = /^[A-Za-z][\w-]*/.exec(rest))) {
      flush()
      out += span('tag', m[0])
    } else {
      plain += rest[0]
      i++
      continue
    }
    i += m[0].length
  }
  flush()
  return out
}

/** A declaration's value: numbers with units, colours, strings, functions, `!important`. */
function cssValue(segment: string): string {
  let out = ''
  let i = 0
  let plain = ''
  const flush = () => {
    if (plain !== '') out += esc(plain)
    plain = ''
  }
  while (i < segment.length) {
    const rest = segment.slice(i)
    let m: RegExpExecArray | null
    if ((m = /^\/\*[\s\S]*?(?:\*\/|$)/.exec(rest))) {
      flush()
      out += span('comment', m[0])
    } else if ((m = /^"(?:\\[\s\S]|[^"\\\n])*"?|^'(?:\\[\s\S]|[^'\\\n])*'?/.exec(rest))) {
      flush()
      out += span('string', m[0])
    } else if ((m = /^#[\da-fA-F]{3,8}\b/.exec(rest))) {
      flush()
      out += span('number', m[0])
    } else if ((m = /^!\s*important\b/i.exec(rest))) {
      flush()
      out += span('keyword', m[0])
    } else if ((m = /^[A-Za-z_-][\w-]*(?=\()/.exec(rest))) {
      flush()
      out += span('function', m[0])
    } else if ((m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?:%|[a-zA-Z]+)?/.exec(rest))) {
      flush()
      out += span('number', m[0])
    } else if ((m = /^[A-Za-z_-][\w-]*/.exec(rest))) {
      // A word (a keyword value, a font name): read on, so digits inside it are not taken for numbers.
      plain += m[0]
    } else {
      plain += rest[0]
      i++
      continue
    }
    if (m) i += m[0].length
  }
  flush()
  return out
}

export function highlightCss(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    // Whitespace and stray closers between statements.
    const gap = /^[\s}]+/.exec(text.slice(i))
    if (gap) {
      out += esc(gap[0])
      i += gap[0].length
      continue
    }
    const comment = /^\/\*[\s\S]*?(?:\*\/|$)/.exec(text.slice(i))
    if (comment) {
      out += span('comment', comment[0])
      i += comment[0].length
      continue
    }
    const end = statementEnd(text, i)
    const segment = text.slice(i, end.at)
    if (end.opens) {
      out += cssSelector(segment) + '{'
      i = end.at + 1
      continue
    }
    // A declaration (`name: value`) or an at-rule ending in `;` (`@import "x";`).
    const property = /^(\s*)(--?[A-Za-z_][\w-]*|[A-Za-z_][\w-]*)(\s*:)([\s\S]*)$/.exec(segment)
    if (property && !segment.trimStart().startsWith('@')) {
      out += esc(property[1]) + span('property', property[2]) + esc(property[3]) + cssValue(property[4])
    } else if (segment.trimStart().startsWith('@')) {
      out += cssSelector(segment)
    } else {
      out += esc(segment)
    }
    if (end.at < text.length) out += text[end.at] === ';' ? ';' : ''
    i = end.at + (text[end.at] === ';' ? 1 : 0)
    if (text[end.at] === '}' || end.at >= text.length) i = end.at
  }
  return out
}
