# Loading the extension (unpacked, for development)

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`, etc. - any
   Chromium browser).
2. Enable "Developer mode" (top-right toggle).
3. Click "Load unpacked" and select this folder
   (`Apps/tab-shortcuts/tab-shortcuts-v1`).
4. Press **Ctrl+Shift+K** (or click the extension's toolbar icon) to open the tab list.

After editing any file, go back to `chrome://extensions` and click the reload icon on the
extension's card to pick up the changes.

# Changing the keyboard shortcut

`chrome://extensions/shortcuts` lets you rebind it per-browser if Ctrl+Shift+K conflicts
with something else - the manifest's `suggested_key` is only the default.
