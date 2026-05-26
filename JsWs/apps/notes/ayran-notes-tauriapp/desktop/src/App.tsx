import React from 'react';
import AppShell from './components/AppShell';
import { ModalStackProvider } from './components/common/ModalStack';
import { PopoverStackProvider } from './components/common/PopoverStack';
import { KeyboardShortcutsProvider, useKeyboardShortcut } from './components/common/KeyboardShortcutsContext';

function AppContent() {
  useKeyboardShortcut('goBack', () => {
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
        el.click();
        break;
      }
    }
  });

  useKeyboardShortcut('listNavFocusContainer', () => {
    const containers = Array.from(
      document.querySelectorAll<HTMLElement>('[data-list-nav-container],[data-focus-target]'),
    );
    for (let i = containers.length - 1; i >= 0; i--) {
      const el = containers[i];
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (getComputedStyle(el).visibility === 'hidden') continue;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const top = document.elementFromPoint(cx, cy);
      if (!top || (!el.contains(top) && el !== top)) continue;
      if (el.tabIndex >= 0) {
        el.focus();
      } else {
        el.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
      }
      break;
    }
  });

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 antialiased">
      <AppShell />
    </div>
  );
}

function App() {
  React.useEffect(() => {
    const appLoader = document.getElementById('app_loader');
    const initialStyles = document.getElementById('initial_style');
    appLoader?.remove();
    initialStyles?.remove();
  }, []);

  return (
    <ModalStackProvider>
      <PopoverStackProvider>
        <KeyboardShortcutsProvider>
          <AppContent />
        </KeyboardShortcutsProvider>
      </PopoverStackProvider>
    </ModalStackProvider>
  );
}

export default App;
