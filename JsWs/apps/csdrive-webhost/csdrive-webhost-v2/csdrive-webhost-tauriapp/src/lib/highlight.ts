/** Syntax highlighting for the text editors (`components/CodeEditor.tsx`): Markdown and HTML.
 *
 * `highlight(text, language)` returns **HTML** — the same text, escaped, with `<span class="tok-…">` around what is worth
 * colouring. The one rule everything here keeps: **the text content of the result is exactly `text`** (every character comes
 * out once, in order, only wrapped or escaped), because the editor draws it under a transparent textarea and the two must
 * line up character for character. (`lib/highlight.test.ts`-style checks in the notes of the change, and `plainTextOf` below,
 * are how that is verified.)
 *
 * The scanners are small and forgiving, not parsers: they colour what a person would expect to see coloured and leave
 * everything else alone. A file too big to colour on every key is left plain (`HIGHLIGHT_LIMIT`). */

import { highlightCss, highlightJavaScript } from './highlightCode'

export type Language = 'markdown' | 'html' | 'css' | 'javascript' | 'text'

/** Text longer than this (characters) isn't coloured: the editor re-draws it on every key. */
export const HIGHLIGHT_LIMIT = 400_000

/** The language a file is highlighted as, from its name. */
export function languageOf(fileName: string): Language {
  const lower = fileName.toLowerCase()
  if (/\.(md|markdown|mdown|mkd)$/.test(lower)) return 'markdown'
  if (/\.(html?|xhtml)$/.test(lower)) return 'html'
  if (/\.css$/.test(lower)) return 'css'
  if (/\.(m?js|cjs|jsx)$/.test(lower)) return 'javascript'
  return 'text'
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
export const escapeHtml = (text: string) => text.replace(/[&<>]/g, (c) => ESCAPES[c])

const span = (kind: string, text: string) => (text === '' ? '' : `<span class="tok-${kind}">${escapeHtml(text)}</span>`)

/** What a highlighted string says once its tags are taken out and its entities put back — for checking that nothing was lost. */
export function plainTextOf(highlighted: string): string {
  return highlighted.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

export function highlight(text: string, language: Language): string {
  if (language === 'text' || text.length > HIGHLIGHT_LIMIT) return escapeHtml(text)
  if (language === 'markdown') return highlightMarkdown(text)
  if (language === 'css') return highlightCss(text)
  if (language === 'javascript') return highlightJavaScript(text)
  return highlightHtml(text)
}

// ── HTML ──────────────────────────────────────────────────────────────────────

/** A tag with its attributes, from the `<` (which the caller has seen) up to and including the `>`, or the end of the text. */
const TAG = /^<\/?[A-Za-z][^\s/>]*(?:"[^"]*"|'[^']*'|[^'">])*>?/
const ATTRIBUTE = /^(\s+)([^\s=/>]+)(?:(\s*=\s*)("[^"]*"?|'[^']*'?|[^\s"'>]+))?/
const ENTITY = /^&(?:#\d+|#x[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/

/** The tag `<name … >` as coloured pieces. */
function highlightTag(tag: string): string {
  const open = /^<\/?/.exec(tag)![0]
  let rest = tag.slice(open.length)
  const name = /^[^\s/>]+/.exec(rest)![0]
  rest = rest.slice(name.length)
  let out = span('tag', open + name)
  while (rest !== '') {
    const attribute = ATTRIBUTE.exec(rest)
    if (attribute) {
      out += escapeHtml(attribute[1]) + span('attr', attribute[2])
      if (attribute[3] !== undefined) out += escapeHtml(attribute[3]) + span('string', attribute[4])
      rest = rest.slice(attribute[0].length)
    } else {
      const punctuation = /^\s*\/?>?|^./s.exec(rest)![0] || rest[0]
      out += span('tag', punctuation)
      rest = rest.slice(punctuation.length)
    }
  }
  return out
}

function highlightHtml(text: string): string {
  let out = ''
  let i = 0
  let plain = ''
  const flush = () => {
    if (plain !== '') out += escapeHtml(plain)
    plain = ''
  }
  while (i < text.length) {
    const ch = text[i]
    if (ch === '<') {
      const here = text.slice(i)
      if (here.startsWith('<!--')) {
        flush()
        const end = text.indexOf('-->', i + 4)
        const stop = end < 0 ? text.length : end + 3
        out += span('comment', text.slice(i, stop))
        i = stop
        continue
      }
      if (here.startsWith('<!') || here.startsWith('<?')) {
        flush()
        const end = text.indexOf('>', i)
        const stop = end < 0 ? text.length : end + 1
        out += span('doctype', text.slice(i, stop))
        i = stop
        continue
      }
      const tag = TAG.exec(here)
      if (tag) {
        flush()
        out += highlightTag(tag[0])
        i += tag[0].length
        // What a script or a style holds is code, not markup: it is left to its own colour until the closing tag.
        const raw = /^<(script|style)\b/i.exec(tag[0])
        if (raw && !tag[0].endsWith('/>')) {
          const close = new RegExp(`</${raw[1]}\\s*>`, 'i').exec(text.slice(i))
          const stop = close ? i + close.index : text.length
          // Its own language: a script is JavaScript, a style is CSS.
          const inner = text.slice(i, stop)
          out += raw[1].toLowerCase() === 'script' ? highlightJavaScript(inner) : highlightCss(inner)
          i = stop
        }
        continue
      }
    }
    if (ch === '&') {
      const entity = ENTITY.exec(text.slice(i, i + 40))
      if (entity) {
        flush()
        out += span('entity', entity[0])
        i += entity[0].length
        continue
      }
    }
    plain += ch
    i++
  }
  flush()
  return out
}

// ── Markdown ──────────────────────────────────────────────────────────────────

/** A web address in running text: it ends at a space or a closing bracket or quote, and its last character isn't sentence
 * punctuation (the dot after "https://example.com/a." is the sentence's). */
export const URL_PATTERN = "https?:\\/\\/[^\\s<>\"')\\]]*[^\\s<>\"')\\].,;:!?]"

/** Inline markdown, in the order things must be looked for: the first alternative that matches at a position wins. */
const INLINE = new RegExp(
  [
    '(?<code>`+)(?<codeBody>.+?)\\k<code>', // `code`
    '(?<comment><!--.*?-->)', // <!-- … --> on one line
    `(?<auto><${URL_PATTERN}>)`, // <https://…>
    '(?<html></?[A-Za-z][^<>]*>)', // <b>, </b>, <a href="…">
    '(?<image>!?\\[)(?<label>[^\\]\\n]*)(?<mid>\\]\\()(?<target>[^)\\s]*)(?<title>(?:\\s+"[^"]*")?)(?<end>\\))', // [text](target) and ![alt](target)
    `(?<url>${URL_PATTERN})`, // https://…
    '(?<![\\w*_])(?<strong>(?<sm>\\*\\*|__)(?=\\S)(?:.+?)(?<=\\S)\\k<sm>)', // **strong**
    '(?<![\\w*_])(?<emphasis>(?<em>\\*|_)(?=[^\\s*_])(?:[^*_\\n]+?)(?<=[^\\s*_])\\k<em>)', // *emphasis*
    '(?<strike>~~(?=\\S)(?:.+?)(?<=\\S)~~)', // ~~struck~~
    '(?<entity>&(?:#\\d+|#x[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);)',
  ].join('|'),
  'gs',
)

/** One line of markdown text (no block markers), as coloured pieces. */
function highlightInline(line: string): string {
  let out = ''
  let last = 0
  INLINE.lastIndex = 0
  for (let m = INLINE.exec(line); m !== null; m = INLINE.exec(line)) {
    if (m[0] === '') {
      INLINE.lastIndex++
      continue
    }
    out += escapeHtml(line.slice(last, m.index))
    const g = m.groups!
    if (g.code !== undefined) out += span('code', m[0])
    else if (g.comment !== undefined) out += span('comment', m[0])
    else if (g.html !== undefined) out += highlightTag(m[0])
    else if (g.image !== undefined) {
      out += span('punct', g.image) + span('linktext', g.label) + span('punct', g.mid) + span('url', g.target) + span('string', g.title) + span('punct', g.end)
    } else if (g.auto !== undefined) out += span('punct', '<') + span('url', m[0].slice(1, -1)) + span('punct', '>')
    else if (g.url !== undefined) out += span('url', m[0])
    else if (g.strong !== undefined) out += span('strong', m[0])
    else if (g.emphasis !== undefined) out += span('emphasis', m[0])
    else if (g.strike !== undefined) out += span('strike', m[0])
    else out += span('entity', m[0])
    last = m.index + m[0].length
  }
  return out + escapeHtml(line.slice(last))
}

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)/
const HEADING = /^(\s{0,3}#{1,6})(\s.*|)$/
const QUOTE = /^(\s{0,3}(?:>\s?)+)(.*)$/
const LIST = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+)(\[[ xX]\]\s+)?(.*)$/
const RULE = /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/
const SETEXT = /^\s{0,3}(?:=+|-+)\s*$/
const REFERENCE = /^(\s{0,3}\[[^\]\n]+\]:\s*)(\S+)(.*)$/

/** A line inside a fenced code block, in the language the fence names (else as plain code). The lines of a block are coloured
 * one by one, so what needs the lines before it (a comment that goes on) is coloured only within its own line. */
function highlightFenced(line: string, language: string): string {
  if (language === 'html' || language === 'xml' || language === 'svg') return highlightHtml(line)
  if (language === 'css') return highlightCss(line)
  if (language === 'js' || language === 'javascript' || language === 'jsx' || language === 'mjs') return highlightJavaScript(line)
  return span('code', line)
}

function highlightMarkdown(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let fence: { mark: string; length: number; language: string } | null = null
  let commentOpen = false
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]
    // A line break that came with \r\n stays outside the coloured piece (it is part of the text all the same).
    const cr = line.endsWith('\r') ? '\r' : ''
    const body = cr ? line.slice(0, -1) : line

    if (fence) {
      const closing = FENCE.exec(body)
      if (closing && closing[2][0] === fence.mark && closing[2].length >= fence.length && body.trim() === closing[2]) {
        out.push(span('fence', body) + cr)
        fence = null
      } else {
        out.push(highlightFenced(body, fence.language) + cr)
      }
      continue
    }
    if (commentOpen) {
      const end = body.indexOf('-->')
      if (end < 0) {
        out.push(span('comment', body) + cr)
      } else {
        out.push(span('comment', body.slice(0, end + 3)) + highlightInline(body.slice(end + 3)) + cr)
        commentOpen = false
      }
      continue
    }
    const opening = FENCE.exec(body)
    if (opening) {
      fence = { mark: opening[2][0], length: opening[2].length, language: opening[3].toLowerCase() }
      out.push(span('fence', body) + cr)
      continue
    }
    const open = body.indexOf('<!--')
    if (open >= 0 && body.indexOf('-->', open) < 0) {
      out.push(highlightInline(body.slice(0, open)) + span('comment', body.slice(open)) + cr)
      commentOpen = true
      continue
    }
    let m: RegExpExecArray | null
    if ((m = HEADING.exec(body))) out.push(span('heading', m[1]) + `<span class="tok-heading">${highlightInline(m[2])}</span>` + cr)
    else if (RULE.test(body) || (SETEXT.test(body) && n > 0 && lines[n - 1].trim() !== '')) out.push(span('rule', body) + cr)
    else if ((m = QUOTE.exec(body))) out.push(span('quote', m[1]) + highlightInline(m[2]) + cr)
    else if ((m = LIST.exec(body))) out.push(span('list', m[1]) + (m[2] ? span('list', m[2]) : '') + highlightInline(m[3]) + cr)
    else if ((m = REFERENCE.exec(body))) out.push(span('punct', m[1]) + span('url', m[2]) + highlightInline(m[3]) + cr)
    else if (/^(?: {4}|\t)\S/.test(body) && (n === 0 || lines[n - 1].trim() === '')) out.push(span('code', body) + cr)
    else out.push(highlightInline(body) + cr)
  }
  return out.join('\n')
}
