import React from 'react';
import AppShell from './components/AppShell';
import { ModalStackProvider } from './components/common/ModalStack';
import { KeyboardShortcutsProvider } from './components/common/KeyboardShortcutsContext';

function App() {
  React.useEffect(() => {
    const appLoader = document.getElementById('app_loader');
    const initialStyles = document.getElementById('initial_style');
    appLoader?.remove();
    initialStyles?.remove();
  }, []);

  return (
    <ModalStackProvider>
      <KeyboardShortcutsProvider>
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 antialiased">
          <AppShell />
        </div>
      </KeyboardShortcutsProvider>
    </ModalStackProvider>
  );
}

export default App;
