import Modal from './Modal';
import type { EditorSettings } from '../types';
import './EditorSettingsDialog.css';

interface EditorSettingsDialogProps {
  settings: EditorSettings;
  onChange: (settings: EditorSettings) => void;
  onClose: () => void;
}

export default function EditorSettingsDialog({ settings, onChange, onClose }: EditorSettingsDialogProps) {
  return (
    <Modal title="Editor settings" onClose={onClose}>
      <label className="editor-settings-row">
        <input
          type="checkbox"
          checked={settings.wrapText}
          onChange={(e) => onChange({ ...settings, wrapText: e.target.checked })}
        />
        <span>Wrap text</span>
      </label>
      <label className="editor-settings-row">
        <input
          type="checkbox"
          checked={settings.highlightWhitespace}
          onChange={(e) => onChange({ ...settings, highlightWhitespace: e.target.checked })}
        />
        <span>Highlight whitespace characters</span>
      </label>
    </Modal>
  );
}
