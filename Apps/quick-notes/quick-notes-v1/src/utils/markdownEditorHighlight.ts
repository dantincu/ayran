import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

export interface HighlightRange {
  start: number;
  end: number;
  className: string;
}

interface MdNode {
  type: string;
  position?: { start: { offset: number }; end: { offset: number } };
  children?: MdNode[];
}

const processor = unified().use(remarkParse).use(remarkGfm);

// Each of these block types gets its own single color for its whole span
// (including nested content) - e.g. a blockquote is tagged as one quote-colored
// unit rather than recursing into distinctly-colored children.
const BLOCK_CLASS: Record<string, string> = {
  heading: 'md-heading',
  code: 'md-code',
  blockquote: 'md-quote',
  thematicBreak: 'md-rule',
  table: 'md-table',
  list: 'md-list',
};

function walk(node: MdNode, out: HighlightRange[]): void {
  const className = BLOCK_CLASS[node.type];
  if (className && node.position) {
    out.push({ start: node.position.start.offset, end: node.position.end.offset, className });
    return;
  }
  if (node.type === 'root') {
    for (const child of node.children ?? []) walk(child, out);
  }
  // paragraphs, html, and anything else: left untagged, so the editor's
  // default text color applies.
}

/** Computes block-level highlight ranges for the raw markdown editor's backdrop. */
export function computeMarkdownHighlightRanges(markdown: string): HighlightRange[] {
  const tree = processor.parse(markdown) as unknown as MdNode;
  const ranges: HighlightRange[] = [];
  walk(tree, ranges);
  ranges.sort((a, b) => a.start - b.start);
  return ranges;
}
