import { useState } from 'react';
import Modal from './Modal';
import type { Stylesheet } from '../types';
import './StylesheetPickerDialog.css';

interface StylesheetPickerDialogProps {
  stylesheets: Stylesheet[];
  editorStylesheetIds: string[];
  previewStylesheetIds: string[];
  onChangeEditor: (ids: string[]) => void;
  onChangePreview: (ids: string[]) => void;
  onSaveAsTemplate: (name: string) => void;
  onClose: () => void;
}

function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

export default function StylesheetPickerDialog({
  stylesheets,
  editorStylesheetIds,
  previewStylesheetIds,
  onChangeEditor,
  onChangePreview,
  onSaveAsTemplate,
  onClose,
}: StylesheetPickerDialogProps) {
  const [templateName, setTemplateName] = useState('');

  const handleSaveTemplate = () => {
    if (!templateName.trim()) return;
    onSaveAsTemplate(templateName.trim());
    setTemplateName('');
  };

  return (
    <Modal title="Stylesheets" onClose={onClose}>
      <section className="stylesheet-picker-section">
        <h3 className="stylesheet-picker-heading">Editor</h3>
        {stylesheets.map((s) => (
          <label key={s.id} className="stylesheet-picker-row">
            <input
              type="checkbox"
              checked={editorStylesheetIds.includes(s.id)}
              onChange={() => onChangeEditor(toggleId(editorStylesheetIds, s.id))}
            />
            <span>{s.name}</span>
          </label>
        ))}
      </section>

      <section className="stylesheet-picker-section">
        <h3 className="stylesheet-picker-heading">Preview</h3>
        {stylesheets.map((s) => (
          <label key={s.id} className="stylesheet-picker-row">
            <input
              type="checkbox"
              checked={previewStylesheetIds.includes(s.id)}
              onChange={() => onChangePreview(toggleId(previewStylesheetIds, s.id))}
            />
            <span>{s.name}</span>
          </label>
        ))}
      </section>

      <section className="stylesheet-picker-section">
        <h3 className="stylesheet-picker-heading">Save this selection as a template</h3>
        <div className="stylesheet-picker-template-row">
          <input
            type="text"
            className="stylesheet-picker-template-input"
            value={templateName}
            onChange={(e) => setTemplateName(e.target.value)}
            placeholder="Template name"
          />
          <button
            type="button"
            className="primary-button stylesheet-picker-save-template"
            disabled={!templateName.trim()}
            onClick={handleSaveTemplate}
          >
            Save
          </button>
        </div>
      </section>
    </Modal>
  );
}
