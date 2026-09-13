import Header from './Header';
import type { Stylesheet } from '../types';
import './StylesheetsListPage.css';

interface StylesheetsListPageProps {
  stylesheets: Stylesheet[];
  onBack: () => void;
  onOpenEditor: (stylesheet: Stylesheet | null) => void;
  onClone: (stylesheet: Stylesheet) => void;
  onDelete: (stylesheet: Stylesheet) => void;
}

export default function StylesheetsListPage({
  stylesheets,
  onBack,
  onOpenEditor,
  onClone,
  onDelete,
}: StylesheetsListPageProps) {
  return (
    <div className="stylesheets-list-page">
      <Header mode="stylesheets-list" onBack={onBack} onNewStylesheet={() => onOpenEditor(null)} />
      <div className="stylesheets-list-page-scroll">
        {stylesheets.map((s) => (
          <div key={s.id} className="stylesheet-row">
            <button
              type="button"
              className="stylesheet-row-name"
              onClick={() => !s.builtin && onOpenEditor(s)}
              disabled={s.builtin}
            >
              <span>{s.name}</span>
              {s.builtin && <span className="stylesheet-row-badge">Built-in</span>}
            </button>
            <div className="stylesheet-row-actions">
              <button
                type="button"
                className="icon-button"
                aria-label={`Clone ${s.name}`}
                onClick={() => onClone(s)}
              >
                <CloneIcon />
              </button>
              {!s.builtin && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Delete ${s.name}`}
                  onClick={() => onDelete(s)}
                >
                  <TrashIcon />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CloneIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0-1 13a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1L6 7" />
    </svg>
  );
}
