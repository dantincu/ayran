import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { RootContent } from 'hast';
import Header from './Header';
import { createId } from '../db/notesDb';
import { highlightCss, isHastElement } from '../utils/cssEditorHighlight';
import type { Stylesheet } from '../types';
import './StylesheetEditor.css';

function renderHastNodes(nodes: RootContent[]): ReactNode[] {
  return nodes.map((node, i) => {
    if (node.type === 'text') return node.value;
    if (isHastElement(node)) {
      const className = Array.isArray(node.properties?.className) ? node.properties.className.join(' ') : undefined;
      return (
        <span key={i} className={className}>
          {renderHastNodes(node.children as RootContent[])}
        </span>
      );
    }
    return null;
  });
}

interface StylesheetEditorProps {
  /** null when creating a brand new stylesheet. */
  stylesheet: Stylesheet | null;
  onSave: (stylesheet: Stylesheet) => void;
  onBack: () => void;
}

export default function StylesheetEditor({ stylesheet, onSave, onBack }: StylesheetEditorProps) {
  const [name, setName] = useState(stylesheet?.name ?? '');
  const [cssText, setCssText] = useState(stylesheet?.cssText ?? '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLPreElement>(null);

  const highlighted = useMemo(() => renderHastNodes(highlightCss(cssText)), [cssText]);
  const canSave = name.trim().length > 0;

  const syncScroll = () => {
    const ta = textareaRef.current;
    const bd = backdropRef.current;
    if (ta && bd) {
      bd.scrollTop = ta.scrollTop;
      bd.scrollLeft = ta.scrollLeft;
    }
  };

  const handleSave = () => {
    if (!canSave) return;
    const now = Date.now();
    const saved: Stylesheet = {
      id: stylesheet?.id ?? createId(),
      name: name.trim(),
      cssText,
      builtin: false,
      createdAt: stylesheet?.createdAt ?? now,
      updatedAt: now,
    };
    onSave(saved);
    onBack();
  };

  return (
    <div className="stylesheet-editor">
      <Header mode="stylesheet-editor" onBack={onBack} onSave={handleSave} canSave={canSave} />
      <input
        className="stylesheet-editor-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Stylesheet name"
        autoFocus={!stylesheet}
      />
      <div className="stylesheet-editor-code-wrap">
        <pre className="stylesheet-editor-backdrop" ref={backdropRef} aria-hidden="true">
          {highlighted}
          {'\n'}
        </pre>
        <textarea
          ref={textareaRef}
          className="stylesheet-editor-textarea"
          value={cssText}
          onChange={(e) => setCssText(e.target.value)}
          onScroll={syncScroll}
          placeholder="/* Write CSS here */"
          spellCheck={false}
        />
      </div>
    </div>
  );
}
