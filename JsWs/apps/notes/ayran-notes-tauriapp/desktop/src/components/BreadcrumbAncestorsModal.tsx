import Modal from './Modal';
import { ClipboardCopyIcon } from './ExplorerIcons';

export interface AncestorEntry {
  name: string;
  /** If true, clicking this entry calls onNavigate(index). */
  navigable: boolean;
}

interface Props {
  entries: AncestorEntry[];
  onNavigate: (index: number) => void;
  onClose: () => void;
}

export default function BreadcrumbAncestorsModal({ entries, onNavigate, onClose }: Props) {
  const pathStr = entries.map(e => e.name).join(' / ');

  const copyPath = () => {
    navigator.clipboard.writeText(pathStr).catch(() => {});
  };

  return (
    <Modal title="Location" onClose={onClose} maxWidth="max-w-sm">
      <div className="p-4 space-y-3">
        <button
          onClick={copyPath}
          title="Copy full path to clipboard"
          className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
        >
          <ClipboardCopyIcon className="w-3.5 h-3.5 shrink-0" />
          Copy path
        </button>

        <div className="space-y-0.5">
          {entries.map((entry, i) => {
            const indent = i * 12;
            const prefix = i === 0 ? '' : '› ';
            return entry.navigable ? (
              <button
                key={i}
                onClick={() => { onNavigate(i); onClose(); }}
                className="w-full text-left text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline py-0.5 transition-colors"
                style={{ paddingLeft: indent }}
              >
                {prefix}{entry.name}
              </button>
            ) : (
              <div
                key={i}
                className="text-sm text-gray-700 dark:text-gray-300 py-0.5 font-medium"
                style={{ paddingLeft: indent }}
              >
                {prefix}{entry.name}
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
