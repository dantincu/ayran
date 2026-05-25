import React from 'react';
import AppShell from './components/AppShell';
import { ModalStackProvider } from './components/common/ModalStack';
import { PopoverStackProvider } from './components/common/PopoverStack';
import { KeyboardShortcutsProvider } from './components/common/KeyboardShortcutsContext';

function App() {
  React.useEffect(() => {
    const appLoader = document.getElementById('app_loader');
    const initialStyles = document.getElementById('initial_style');
    appLoader?.remove();
    initialStyles?.remove();
  }, []);

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.key !== 'Escape') return;
      const buttons = Array.from(document.querySelectorAll<HTMLElement>('[data-back-btn]'));
      for (let i = buttons.length - 1; i >= 0; i--) {
        const el = buttons[i];
        if ((el as HTMLButtonElement).disabled) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (getComputedStyle(el).visibility === 'hidden') continue;
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const top = document.elementFromPoint(cx, cy);
        if (top && (el === top || el.contains(top))) {
          e.preventDefault();
          el.click();
          break;
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  React.useEffect(() => {
    let ctrlMPressed = false;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return;
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyM') {
        ctrlMPressed = true;
        return;
      }
      if (ctrlMPressed) {
        ctrlMPressed = false;
        if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyF') {
          e.preventDefault();
          const containers = Array.from(
            document.querySelectorAll<HTMLElement>('[data-list-nav-container]'),
          );
          for (let i = containers.length - 1; i >= 0; i--) {
            const el = containers[i];
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden') {
              el.focus();
              break;
            }
          }
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  return (
    <ModalStackProvider>
      <PopoverStackProvider>
        <KeyboardShortcutsProvider>
          <div className="min-h-screen bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 antialiased">
            <AppShell />
          </div>
        </KeyboardShortcutsProvider>
      </PopoverStackProvider>
    </ModalStackProvider>
  );
}

export default App;
