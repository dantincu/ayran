import type { CSSProperties } from 'react';
import type { NoteLabel } from '../types';
import './LabelChip.css';

interface LabelChipProps {
  label: NoteLabel;
  onClick?: () => void;
}

export default function LabelChip({ label, onClick }: LabelChipProps) {
  const style: CSSProperties = {
    background: label.bg ?? 'var(--label-default-bg)',
    color: label.fg ?? 'var(--label-default-fg)',
  };
  const text = label.text.trim() || 'Label';

  if (onClick) {
    return (
      <button type="button" className="label-chip label-chip-button" style={style} onClick={onClick}>
        {text}
      </button>
    );
  }
  return (
    <span className="label-chip" style={style}>
      {text}
    </span>
  );
}
