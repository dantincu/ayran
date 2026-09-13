import { common, createLowlight } from 'lowlight';
import type { Element as HastElement, RootContent } from 'hast';

const lowlight = createLowlight(common);

/**
 * hast child nodes for syntax-highlighted CSS source, used to render the
 * stylesheet editor's backdrop (see StylesheetEditor.tsx). Reuses the same
 * lowlight/highlight.js grammar already pulled in for preview code-fence
 * highlighting (see NoteEditor.tsx's rehype-highlight usage), so the classes
 * this produces (hljs-selector-class, hljs-attribute, hljs-string, ...) are
 * ones the app already styles.
 */
export function highlightCss(cssText: string): RootContent[] {
  return lowlight.highlight('css', cssText).children;
}

export function isHastElement(node: RootContent): node is HastElement {
  return node.type === 'element';
}
