import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { parseHtmlChunk, flattenHtmlUnits } from './htmlChunk';

interface MdNode {
  type: string;
  value?: string;
  position?: { start: { offset: number }; end: { offset: number } };
  children?: MdNode[];
}

interface Range {
  start: number;
  end: number;
}

// Container block types: their contents are "treated directly" (recursed into)
// rather than snapped as one whole unit. Blockquotes are explicitly called out
// in the spec; lists/list items are treated the same way since they're likewise
// structural wrappers around leaf content blocks rather than leaf content themselves.
const CONTAINER_TYPES = new Set(['root', 'blockquote', 'list', 'listItem']);

const processor = unified().use(remarkParse).use(remarkGfm);

function collectMarkdownUnits(node: MdNode, out: Range[]): void {
  if (node.type === 'html') {
    if (node.value !== undefined && node.position) {
      const chunk = parseHtmlChunk(node.value, node.position.start.offset);
      flattenHtmlUnits(chunk, out);
    }
    return;
  }

  if (CONTAINER_TYPES.has(node.type)) {
    for (const child of node.children ?? []) collectMarkdownUnits(child, out);
    return;
  }

  if (node.position) {
    out.push({ start: node.position.start.offset, end: node.position.end.offset });
  }
}

function buildAtomicUnits(markdown: string): Range[] {
  const tree = processor.parse(markdown) as unknown as MdNode;
  const units: Range[] = [];
  collectMarkdownUnits(tree, units);
  units.sort((a, b) => a.start - b.start);
  return units;
}

function trimWhitespace(markdown: string, range: Range): Range {
  const text = markdown.slice(range.start, range.end);
  const leading = text.match(/^\s*/)?.[0].length ?? 0;
  const trailing = text.match(/\s*$/)?.[0].length ?? 0;
  const start = range.start + leading;
  const end = range.end - trailing;
  if (start >= end) return range;
  return { start, end };
}

/**
 * Computes the "snap select whole paragraphs" replacement selection: every
 * atomic block (paragraph, heading, rule, table, code block, html leaf/parent
 * start-tag or child) that the current selection partially or fully touches
 * gets fully selected, with outer leading/trailing whitespace trimmed.
 * Returns null when no change should be made (e.g. selection touches nothing).
 */
export function computeWholeParagraphsSelection(
  markdown: string,
  selStart: number,
  selEnd: number,
): Range | null {
  const units = buildAtomicUnits(markdown);

  const touchesUnit = (u: Range) =>
    selStart === selEnd ? u.start <= selStart && selStart <= u.end : u.start < selEnd && u.end > selStart;

  let start = Infinity;
  let end = -Infinity;
  for (const u of units) {
    if (touchesUnit(u)) {
      if (u.start < start) start = u.start;
      if (u.end > end) end = u.end;
    }
  }

  if (start === Infinity) return null;

  return trimWhitespace(markdown, { start, end });
}
