# Keyboard shortcuts

Every keyboard shortcut in CsDrive WebHost. **Ctrl** below is **⌘** on a Mac. On a phone or tablet everything can be done by touch; the shortcuts
are for a keyboard (or an emulator's).

## Anywhere in the admin-app

| Keys | What it does |
| --- | --- |
| **Ctrl+K, T** | Opens the **tab switcher**: every tab of the admin-app with a number in front. Type the tab's number (the box is focused at once) and press **Enter** to go there. Pressing a row goes there too. Press **Ctrl+K, T** again or **Esc** to close it. A number that isn't a tab turns the box red. |

### Two-key shortcuts — Ctrl+K, then a letter

There are only so many letters to hold with Ctrl, so the app's shortcuts are **chords**: press **Ctrl+K** (⌘K on a Mac), let go, then press a letter (within 3 seconds). While the chord waits, a small hint at the bottom of the window — **glowing**, and above any dialog — lists what the letters do *here*, and the entry of the letter you press lights up for a moment; **Esc** or a letter that isn't a shortcut cancels it. **Ctrl+K on its own no longer opens the tab switcher** — that is now Ctrl+K, T.

| Chord | Where | What it does |
| --- | --- | --- |
| **Ctrl+K, T** | admin-app | The tab switcher (above). |
| **Ctrl+K, M** | anywhere a popup is open | **Maximizes** the popup on top (a dialog or an editor) — the whole window less a margin, so it still reads as a popup: 6px on a phone, growing with the width up to 40px on a Full HD screen — or restores it. The popups also have a button for it. |
| **Ctrl+K, C** | a text box or editor has the focus, with text selected | Copies the selection to the **app's own clipboard** (the one shared by every window; not the system's). |
| **Ctrl+K, V** | a text box or editor has the focus | Pastes the app's clipboard over the selection. |
| **Ctrl+K, X** | anywhere | **Clears** the app's clipboard. (Settings shows what it holds, and has a button for it.) |

The tabs are numbered in the order of the tab bar: 1 System Apps, 2 User Apps, 3 Files, 4 Filen.io, 5 SQLite, 6 Storage, 7 Settings. Hover a
tab to see its number.

## Lists

These work on every list you can browse — no need to click it first, the keys are heard on the whole window.

| Keys | What it does |
| --- | --- |
| **↓** / **↑** | Focus the next / previous item. (With nothing focused yet, either one focuses the first item — in a paginated list, the first item of the page shown.) |
| **Home** / **End** | Focus the first / last item — in a paginated list, of the **page** the focus is on (not of all the pages). |
| **Page Down** / **Page Up** | Move the focus 10 items down / up. In a paginated list this stays inside the page: with fewer than 10 items left it stops at the page's last / first item, and pressed *there* it goes on to the **next page's first item** / **previous page's last item**. |
| **←** | Go to the **parent**: up a folder, or up a level (opened item → tab → tab group → window → app), or close the open database / object store. The item you just came from is focused. |
| **→** | Go into the **focused item**: open a folder, open a file to edit it, open an app's windows, a window's tab groups, a tab group's tabs, what was **opened from a tab** (its web apps and external web sites), a database's tables or stores. On an external web site, → brings its window to the front (or opens it again). A folder you enter has its first item focused. |
| **Enter** | The focused item's own action: on a **tab**, show it (its window opens if need be); on anything else, the same as →. (Not heard while a button or link has the focus — Enter presses that.) |

The focused item is outlined. Pressing on an item with the mouse or a finger moves the focus there, so the keys carry on from where you clicked.

Where the list keys apply:

- **System Apps** and **User Apps** — apps → windows → tab groups → tabs → what was opened from the tab (web apps opened from a Notes tab, and external web sites)
- **Files** and **Filen.io** — the folder's entries
- **Notes** — the folder's entries, on this device and in a Filen account (in a branch too); and the list of notebooks (→ / Enter shows the notebook's folder in the file manager, ← goes to the Notes home page)
- **SQLite** — the databases, then the tables of the open one
- **Storage → IndexedDB** — databases → object stores → records

They do **not** apply to the Local / Session storage tables, Settings or the tag editors.

The list keys are **ignored** while you are typing in a text box, while a dialog or a popover is open, and while a file is open in the editor — those
keep their own keys (below).

## Paginated lists — go to a page

Every paginated list (Files, Filen.io, Notes) has the page indicator, `3 / 12`, between the previous / next buttons.

| Keys | What it does |
| --- | --- |
| **Ctrl+G** | Opens the **page list** with a box to **type a page number**: **Enter** goes to that page (a number outside the range turns the box red). |
| *Press the indicator* (mouse or touch) | Opens the same page list *without* the number box: press a page number to go there. |
| **Esc** | Closes the page list (so does pressing anywhere outside it). |

The current page is highlighted in the list, and a second outline — the **cursor** — shows where the keys have taken you. While the page list is open:

| Keys | What it does |
| --- | --- |
| **←** / **→** | Move the cursor to the previous / next page number. |
| **↑** / **↓** | Move the cursor to the same column of the previous / next **row** of page numbers (on a shorter last row, to its last number). |
| **Page Up** / **Page Down** | Move the cursor up / down by **half the height** of the list, in rows. |
| **Home** / **End** | Move the cursor to the first / last page. |
| **Enter** | Go to the page under the cursor (when no number has been typed; with one typed, to that number). |
| *Typing a number* | The cursor follows it. |

The popover is as tall as the screen allows; the list scrolls (vertically, inside the popover) when there are more pages than fit, and follows the cursor. **Ctrl+G** is ignored while a dialog or the editor is open.

## Dialogs, editors and text boxes

| Keys | What it does |
| --- | --- |
| **Esc** | Closes the topmost dialog (a dialog opened from another closes alone, not both). In the conflict dialog Esc means **Cancel**. |
| **Enter** | In a rename box (Files, Notes): applies the new name. In a name box of a dialog (rename a tab group, deploy an app, add a tag…) and in *new database*: confirms. In the tab switcher and the page list: goes to the number typed. |
| **Esc** | In a rename box (Files, Notes) or when editing a value in Local / Session storage: cancels. |

## Text boxes and editors — select, copy, paste

Not keys, but the same job: while a text editor or a single-line text box has the focus, a small **…** button appears at its top-right corner (touch and mouse). It opens:

| Item | What it does |
| --- | --- |
| **Select paragraphs** (a single-line box: **Select all**) | Selects the paragraph(s) the selection touches or the caret is in — a paragraph is what lies between blank lines — without the blank space around them. |
| **Copy to the app's clipboard** / **Paste from the app's clipboard** | The app's own clipboard: one text, shared by every window of the app, separate from the system's. Pasting replaces the selection. |
| **Copy to the clipboard** / **Paste from the clipboard** | The system's clipboard. Where the webview won't let the app read it, use **Ctrl+V** (or press and hold in the box). |

**Esc** closes the menu.

## The media viewer (Notes' File Manager and Note Files Explorer)

| Keys | What it does |
| --- | --- |
| **Esc** | Close the viewer (leaves full screen first, in a browser that does so itself). |
| **PageDown** / **PageUp** | The next / previous picture, video or sound of the folder. |
| **→** / **←** | A picture: the next / previous one. A video or sound: forward / back 10 seconds. |
| **Space** | Play or pause a video or a sound. |
| **F** | Full screen (and back). |
| **+** / **−** / **0** | A picture: zoom in / out / show the whole picture. (The wheel zooms too, a double click toggles, and a pinch works on a touch screen.) |

One press on a picture (or on a playing video) hides or brings back the bars. The ten-second buttons act on the press, not the release.

## Notes

| Keys | What it does |
| --- | --- |
| **Ctrl+S** | On a note's editing page: saves the note. |

## Keeping this list right

The shortcuts are defined in code — `src/lib/keyboard.ts` (the list keys), `src/lib/chords.ts` and `src/components/ChordHost.tsx` (the two-key
shortcuts), `src/components/Pagination.tsx` — and described for developers in the "Keyboard" section of `CLAUDE.md`. **A new shortcut is added to this list in the
same change.**
