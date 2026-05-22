import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import { visit } from 'unist-util-visit';

/**
 * Parses a markdown string — which may contain embedded HTML, <script>, and <style>
 * blocks — and returns the plain-text content of the first primary heading
 * (either a markdown `# Heading` or an HTML `<h1>`).
 * Returns null when no h1 is found.
 */
export async function extractFirstH1(markdown: string): Promise<string | null> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hast: any = await processor.run(processor.parse(markdown));

  let h1Text: string | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  visit(hast, 'element', (node: any) => {
    if (h1Text !== null) return;
    if (node.tagName === 'h1') {
      let text = '';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      visit(node, 'text', (t: any) => { text += t.value as string; });
      h1Text = text.trim() || null;
    }
  });

  return h1Text;
}
