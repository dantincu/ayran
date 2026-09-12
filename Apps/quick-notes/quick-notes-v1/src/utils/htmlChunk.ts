export interface HtmlUnit {
  kind: 'text' | 'leaf' | 'parent';
  start: number;
  end: number;
  /** For 'parent' units only: offset just past the opening tag's '>'. */
  openEnd?: number;
  children?: HtmlUnit[];
}

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const TAG_RE = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)(?:\s+[^<>]*)?\s*(\/)?>/g;

interface OpenFrame {
  tag: string;
  start: number;
  openEnd: number;
  children: HtmlUnit[];
}

/**
 * Tokenizes a raw HTML chunk (as found in an mdast `html` node) into a tree of
 * text runs, leaf elements (void/self-closing, or unmatched), and parent elements.
 * `base` is the absolute offset of `value[0]` within the full document.
 */
export function parseHtmlChunk(value: string, base: number): HtmlUnit[] {
  const root: HtmlUnit[] = [];
  const stack: OpenFrame[] = [];
  let lastIndex = 0;

  const currentChildren = () => (stack.length ? stack[stack.length - 1].children : root);
  const pushText = (start: number, end: number) => {
    if (end > start) currentChildren().push({ kind: 'text', start: base + start, end: base + end });
  };

  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(value))) {
    pushText(lastIndex, match.index);
    lastIndex = TAG_RE.lastIndex;

    const full = match[0];
    if (full.startsWith('<!--')) {
      currentChildren().push({ kind: 'text', start: base + match.index, end: base + lastIndex });
      continue;
    }

    const closingTag = match[1];
    const openTag = match[2];
    const selfClose = match[3];

    if (closingTag) {
      let depthIdx = -1;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag.toLowerCase() === closingTag.toLowerCase()) {
          depthIdx = i;
          break;
        }
      }
      if (depthIdx === -1) {
        currentChildren().push({ kind: 'text', start: base + match.index, end: base + lastIndex });
        continue;
      }
      const popCount = stack.length - depthIdx;
      for (let i = 0; i < popCount; i++) {
        const frame = stack.pop() as OpenFrame;
        const parentChildren = stack.length ? stack[stack.length - 1].children : root;
        parentChildren.push({
          kind: 'parent',
          start: frame.start,
          end: base + lastIndex,
          openEnd: frame.openEnd,
          children: frame.children,
        });
      }
      continue;
    }

    if (openTag) {
      const isVoid = VOID_TAGS.has(openTag.toLowerCase());
      if (selfClose || isVoid) {
        currentChildren().push({ kind: 'leaf', start: base + match.index, end: base + lastIndex });
      } else {
        stack.push({ tag: openTag, start: base + match.index, openEnd: base + lastIndex, children: [] });
      }
    }
  }
  pushText(lastIndex, value.length);

  while (stack.length) {
    const frame = stack.pop() as OpenFrame;
    const parentChildren = stack.length ? stack[stack.length - 1].children : root;
    // Unclosed tag: best-effort, treat everything it opened as one leaf run.
    parentChildren.push({ kind: 'leaf', start: frame.start, end: base + value.length });
  }

  return root;
}

/**
 * Flattens the html unit tree into atomic snap units:
 * - text / leaf units are atomic as-is
 * - a parent element contributes its own opening tag as one atomic unit,
 *   plus the recursively-flattened units of its children (its closing tag
 *   is not independently selectable)
 */
export function flattenHtmlUnits(units: HtmlUnit[], out: Array<{ start: number; end: number }>): void {
  for (const unit of units) {
    if (unit.kind === 'text' || unit.kind === 'leaf') {
      out.push({ start: unit.start, end: unit.end });
    } else {
      out.push({ start: unit.start, end: unit.openEnd ?? unit.start });
      if (unit.children) flattenHtmlUnits(unit.children, out);
    }
  }
}
