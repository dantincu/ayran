# Ayran Fav Tabs

A Chromium (Chrome / Edge / Brave …) extension, Manifest V3, that remembers browser tabs you choose. The spec is in [CLAUDE.md](CLAUDE.md).

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. **Load unpacked** → pick this folder.
3. Pin the extension to the toolbar.

No build step: the sources are loaded as they are.

## Use

| Action | Result |
|---|---|
| Click the toolbar icon | remember / forget the current tab (a ★ badge marks remembered tabs) |
| Right-click the toolbar icon → **Open the Fav Tabs list**, or **Alt+Shift+F** | open (or focus) the list |
| **Alt+Shift+K** | remember / forget the current tab |
| **Remember all** button in the list | remember every open tab of the list's window, or of all windows (tabs already remembered are skipped) |

Shortcuts can be changed at `chrome://extensions/shortcuts`.

In the list:

- **click** a tab head: focus its browser tab, or open it in a new tab if it's closed (closed tabs are shown faded and in italics);
- **middle click**: close the browser tab (it stays remembered);
- **×**: forget it (the browser tab stays open); forgetting shows an **Undo** toast;
- **right click**: Select / Forget Tab / Close Tab / Forget and Close Tab;
- **click the icon**: show the browser tabs on the same second level domain, labelled
  *Exact match* (light green), *Equal* (dark green), *Partial (same domain)* (blue), *Partial (same 2nd level domain)* (no color).
  Click a row to focus that tab; right click → **Switch to This Tab** makes the remembered entry follow that tab instead.
  **Esc**, **Alt+Left** or **Back** returns to the list.

Select mode (**Select** button, or right click → Select):

- checkboxes; **Shift+click** a checkbox sets the whole range (from the previously clicked checkbox) to the clicked checkbox's new state, so it selects or unselects ranges;
- **All** (Ctrl+A) / **None**, **Forget**, **Close**, **Forget & Close** the selected tabs;
- reorder: drag selected heads (the page auto-scrolls near its top and bottom edges), or the buttons
  Start, Page up (10, right click 30), Up (1, right click 3), Down, Page down, End;
- **Done** or **Esc** leaves select mode.

Settings (gear icon): show the url under the title, and the tab head width (default 200 px).

## How it works

- `src/background.js` (service worker) follows remembered tabs: url, title and favicon are updated as the tab navigates; when a tab closes the entry is kept with no tab. Favicons are also cached as `data:` urls (read from the browser's own favicon store), so they still show when the site is unreachable.
- No scripts run in web pages and no site access is requested: the extension only uses the `tabs`, `storage`, `favicon` and `contextMenus` permissions.
- Entries live in `chrome.storage.local`, in list order. Writes from the service worker and the list page go through one Web Lock (`src/shared/store.js`), so they never overwrite each other.
- Tab ids don't survive a browser restart. After a restart, remembered tabs are re-adopted by exact url as the session restores them (also when a closed window is reopened).
- Right-clicking an extension's icon always shows the browser's own menu for it; the extension adds **Open the Fav Tabs list** at its top (an extension can't replace that menu with an action of its own).
- "Second level domain" uses the last two labels of the host, or the last three for hosts like `bbc.co.uk` (a short built-in list, not the full public suffix list).

## Develop

```sh
npm test            # unit tests (url matching, reordering) - Node 20+
npm run icons       # regenerate icons/*.png
```

From the service worker's DevTools console, `favTabs.toggleTab(tab)` and `favTabs.openView()` are available for debugging.
