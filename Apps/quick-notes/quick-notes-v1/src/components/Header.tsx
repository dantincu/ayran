import OptionsMenu from './OptionsMenu';
import './Header.css';

interface ListHeaderProps {
  mode: 'list';
  selectionMode: boolean;
  selectedCount: number;
  hasNotes: boolean;
  onNewNote: () => void;
  onSelectAll: () => void;
  onCancelSelection: () => void;
  onDeleteSelected: () => void;
}

interface EditorHeaderProps {
  mode: 'editor';
  onBack: () => void;
  previewing: boolean;
  onTogglePreview: () => void;
  onOptionsOpen: () => void;
  onSnapWholeParagraphs: () => void;
  onDeleteNote: () => void;
  onUndo: () => void;
  canUndo: boolean;
}

type HeaderProps = ListHeaderProps | EditorHeaderProps;

export default function Header(props: HeaderProps) {
  return (
    <header className="app-header">
      <div className="app-header-left">
        {props.mode === 'editor' ? (
          <button type="button" className="icon-button" aria-label="Back to notes" onClick={props.onBack}>
            <BackIcon />
          </button>
        ) : (
          <span className="app-title">Quick Notes</span>
        )}
      </div>

      {props.mode === 'list' && props.selectionMode && (
        <div className="app-header-center">{props.selectedCount} selected</div>
      )}

      <div className="app-header-right">
        {props.mode === 'list' && !props.selectionMode && (
          <>
            {props.hasNotes && (
              <button type="button" className="icon-button" aria-label="New note" onClick={props.onNewNote}>
                <PlusIcon />
              </button>
            )}
            <OptionsMenu
              entries={[{ type: 'item', label: 'Select all notes', onSelect: props.onSelectAll }]}
            />
          </>
        )}

        {props.mode === 'list' && props.selectionMode && (
          <>
            {props.selectedCount > 0 && (
              <button
                type="button"
                className="icon-button"
                aria-label="Delete selected notes"
                onClick={props.onDeleteSelected}
              >
                <TrashIcon />
              </button>
            )}
            <button type="button" className="icon-button" aria-label="Cancel selection" onClick={props.onCancelSelection}>
              <CloseIcon />
            </button>
          </>
        )}

        {props.mode === 'editor' && (
          <>
            <button
              type="button"
              className="icon-button"
              aria-label="Undo"
              disabled={!props.canUndo}
              onClick={props.onUndo}
            >
              <UndoIcon />
            </button>
            <button
              type="button"
              className={`icon-button${props.previewing ? ' icon-button-active' : ''}`}
              aria-label={props.previewing ? 'Edit note' : 'Preview note'}
              aria-pressed={props.previewing}
              onClick={props.onTogglePreview}
            >
              <EyeIcon />
            </button>
            <OptionsMenu
              onOpen={props.onOptionsOpen}
              entries={[
                {
                  type: 'submenu',
                  label: 'Snap select',
                  items: [
                    {
                      type: 'item',
                      label: 'Whole paragraphs',
                      onSelect: props.onSnapWholeParagraphs,
                      disabled: props.previewing,
                    },
                  ],
                },
                { type: 'item', label: 'Delete note', onSelect: props.onDeleteNote, danger: true },
              ]}
            />
          </>
        )}
      </div>
    </header>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0-1 13a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1L6 7" />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
