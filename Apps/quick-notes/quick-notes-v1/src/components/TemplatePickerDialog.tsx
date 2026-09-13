import Modal from './Modal';
import type { NoteTemplate } from '../types';
import './TemplatePickerDialog.css';

interface TemplatePickerDialogProps {
  templates: NoteTemplate[];
  onChoose: (template: NoteTemplate) => void;
  onDelete: (template: NoteTemplate) => void;
  onClose: () => void;
}

export default function TemplatePickerDialog({ templates, onChoose, onDelete, onClose }: TemplatePickerDialogProps) {
  return (
    <Modal title="Note from template" onClose={onClose}>
      {templates.length === 0 ? (
        <p className="template-picker-empty">
          No templates yet. Open a note, pick "Stylesheets…", and save your current selection as a template.
        </p>
      ) : (
        <ul className="template-picker-list">
          {templates.map((t) => (
            <li key={t.id} className="template-picker-row">
              <button type="button" className="template-picker-name" onClick={() => onChoose(t)}>
                {t.name}
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Delete template ${t.name}`}
                onClick={() => onDelete(t)}
              >
                <TrashIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
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
