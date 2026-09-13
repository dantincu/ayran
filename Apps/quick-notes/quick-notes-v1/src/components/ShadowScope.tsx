import { useCallback, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface ShadowScopeProps {
  /** className for the light-DOM host element (box layout only - the shadow boundary starts inside it). */
  hostClassName?: string;
  /** Always-injected, non-toggleable mechanical CSS (layout, positioning). Rendered first. */
  shellCss: string;
  /** Toggleable stylesheet CSS text, in the order they should cascade. */
  contentCss: string[];
  children: ReactNode;
}

/**
 * Renders children inside an open Shadow DOM root, so arbitrary user-authored
 * CSS (in contentCss) can restyle them without any risk of reaching outside -
 * selectors like `* { display: none }` in a custom stylesheet can only ever
 * affect this shadow tree, never the app's own header/buttons/other notes.
 * CSS custom properties (theme vars) still inherit through the shadow
 * boundary normally, so `var(--accent)` etc. keep working with no extra wiring.
 */
export default function ShadowScope({ hostClassName, shellCss, contentCss, children }: ShadowScopeProps) {
  const [shadowRoot, setShadowRoot] = useState<ShadowRoot | null>(null);

  const hostRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    // React (StrictMode in dev) can "reappear" the same DOM node across a
    // simulated unmount/remount without actually destroying it, so attachShadow()
    // must not be called twice on one element - reuse the node's own shadow
    // root (tracked by the browser, not by React state) if it already has one.
    setShadowRoot(node.shadowRoot ?? node.attachShadow({ mode: 'open' }));
  }, []);

  return (
    <div ref={hostRef} className={hostClassName}>
      {shadowRoot &&
        createPortal(
          <>
            <style>{shellCss}</style>
            {contentCss.map((css, i) => (
              <style key={i}>{css}</style>
            ))}
            {children}
          </>,
          shadowRoot,
        )}
    </div>
  );
}
