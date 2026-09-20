# Keyboard shortcuts

Every keyboard shortcut in CsDrive WebHost. **Ctrl** below is **⌘** on a Mac. On a phone or tablet everything can be done by touch; the shortcuts
are for a keyboard (or an emulator's).

## Anywhere in the admin-app

| Keys | What it does |
| --- | --- |
| **Ctrl+K** | Opens the **tab switcher**: every tab of the admin-app with a number in front. Type the tab's number (the box is focused at once) and press **Enter** to go there. Pressing a row goes there too. Press **Ctrl+K** again or **Esc** to close it. A number that isn't a tab turns the box red. |

The tabs are numbered in the order of the tab bar: 1 System Apps, 2 User Apps, 3 Files, 4 Filen.io, 5 SQLite, 6 Storage, 7 Settings. Hover a
tab to see its number.

## Lists

These work on every list you can browse — no need to click it first, the keys are heard on the whole window.

| Keys | What it does |
| --- | --- |
| **↓** / **↑** | Focus the next / previous item. (With nothing focused yet, either one focuses the first item.) |
| **Home** / **End** | Focus the first / last item — in a paginated list, of *all* the pages; the page shown follows. |
| **Page Down** / **Page Up** | Move the focus 10 items down / up. |
| **←** | Go to the **parent**: up a folder, or up a level (tab → tab group → window → app), or close the open database / object store. The item you just came from is focused. |
| **→** | Go into the **focused item**: open a folder, open a file to edit it, open an app's windows, a window's tab groups, a tab group's tabs, a database's tables or stores. On a **tab**, → activates it (shows its window, opening it if need be). A folder you enter has its first item focused. |

The focused item is outlined. Pressing on an item with the mouse or a finger moves the focus there, so the keys carry on from where you clicked.

Where the list keys apply:

- **System Apps** and **User Apps** — apps → windows → tab groups → tabs
- **Files** and **Filen.io** — the folder's entries
- **Notes** — the folder's entries, on this device and in a Filen account (in a branch too)
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

The current page is highlighted in the list. **Ctrl+G** is ignored while a dialog or the editor is open.

## Dialogs, editors and text boxes

| Keys | What it does |
| --- | --- |
| **Esc** | Closes the topmost dialog (a dialog opened from another closes alone, not both). In the conflict dialog Esc means **Cancel**. |
| **Enter** | In a rename box (Files, Notes): applies the new name. In a name box of a dialog (rename a tab group, deploy an app, add a tag…) and in *new database*: confirms. In the tab switcher and the page list: goes to the number typed. |
| **Esc** | In a rename box (Files, Notes) or when editing a value in Local / Session storage: cancels. |

## Keeping this list right

The shortcuts are defined in code — `src/lib/keyboard.ts` (the letters and the list keys), `src/components/TabSwitcher.tsx`,
`src/components/Pagination.tsx` — and described for developers in the "Keyboard" section of `CLAUDE.md`. **A new shortcut is added to this list in the
same change.**
