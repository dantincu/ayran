import { useState } from 'react';
import Modal from './Modal';
import LabelChip from './LabelChip';
import ColorPicker from './ColorPicker';
import { createId } from '../db/notesDb';
import type { NoteLabel } from '../types';
import './LabelEditorDialog.css';

interface LabelEditorDialogProps {
  labels: NoteLabel[];
  onChange: (labels: NoteLabel[]) => void;
  onClose: () => void;
}

export default function LabelEditorDialog({ labels, onChange, onClose }: LabelEditorDialogProps) {
  const [openPickerId, setOpenPickerId] = useState<string | null>(null);

  const updateLabel = (id: string, patch: Partial<NoteLabel>) => {
    onChange(labels.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  };

  const removeLabel = (id: string) => {
    if (openPickerId === id) setOpenPickerId(null);
    onChange(labels.filter((l) => l.id !== id));
  };

  const addLabel = () => {
    const label: NoteLabel = { id: createId(), text: '' };
    onChange([...labels, label]);
    setOpenPickerId(label.id);
  };

  return (
    <Modal title="Labels" onClose={onClose}>
      <ul className="label-editor-list">
        {labels.map((label) => (
          <li key={label.id} className="label-editor-row">
            <div className="label-editor-row-main">
              <button
                type="button"
                className="label-editor-swatch"
                aria-label="Change label color"
                onClick={() => setOpenPickerId(openPickerId === label.id ? null : label.id)}
              >
                <LabelChip label={label} />
              </button>
              <input
                type="text"
                className="label-editor-text"
                value={label.text}
                placeholder="Label text"
                onChange={(e) => updateLabel(label.id, { text: e.target.value })}
              />
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove label ${label.text || 'untitled'}`}
                onClick={() => removeLabel(label.id)}
              >
                <TrashIcon />
              </button>
            </div>
            {openPickerId === label.id && (
              <ColorPicker
                fg={label.fg}
                bg={label.bg}
                onChange={(fg, bg) => updateLabel(label.id, { fg, bg })}
              />
            )}
          </li>
        ))}
      </ul>
      <button type="button" className="primary-button label-editor-add" onClick={addLabel}>
        Add label
      </button>
    </Modal>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0-1 13a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1L6 7" />
    </svg>
  );
}
