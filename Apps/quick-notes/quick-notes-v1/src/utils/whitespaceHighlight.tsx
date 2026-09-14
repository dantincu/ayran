import type { ReactNode } from 'react';

/**
 * Splits text into plain runs and per-character whitespace spans. Tabs and
 * newlines get their own class (for a symbol overlay via CSS ::before);
 * every other whitespace character (space included) just gets a background.
 * Never changes the character count, so backdrop/textarea alignment holds.
 */
export function renderWithWhitespaceHighlight(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let plainStart = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!/\s/.test(ch)) continue;
    if (i > plainStart) nodes.push(text.slice(plainStart, i));
    const className = ch === '\t' ? 'ws-tab' : ch === '\n' ? 'ws-newline' : 'ws-space';
    nodes.push(
      <span key={`${keyPrefix}-${i}`} className={className}>
        {ch}
      </span>,
    );
    plainStart = i + 1;
  }
  if (plainStart < text.length) nodes.push(text.slice(plainStart));
  return nodes;
}
