/** The API reference shown in the Help tab (`HelpTab.tsx`) — every backend command granted to a web app
 * (`src-tauri/capabilities/user-apps.json`), as a plain web app would actually call it: `window.__TAURI__.core.invoke(...)`.
 * The admin-app's own internal `src/lib/*.ts` wrappers (camelCase functions) exist for this app's own React code and
 * aren't shipped to a web app's page, so the calls below are written the way a page really has to write them.
 *
 * **Keep this in sync with the Rust API.** Whenever a command is added, renamed, or has its parameters/behavior
 * change in `src-tauri/capabilities/user-apps.json` or the commands it grants, update the matching entry here (or
 * add/remove one) in the same change — this file has no other source of truth and nothing checks it against the
 * Rust side automatically. */

export interface ApiEntry {
  /** The call, exactly as a page would write it. */
  call: string
  /** What it resolves to. */
  returns: string
  /** One line: what it does. */
  summary: string
  /** A caveat worth calling out (Notes-only, admin-only, asks the person first, ...). */
  note?: string
}

export interface ApiCategory {
  title: string
  intro?: string
  entries: ApiEntry[]
}

export const API_REFERENCE: ApiCategory[] = [
  {
    title: 'Files',
    intro:
      'Every call names a root — "user" (the user folder) or the opaque id of a folder the person picked (see "Picked folders" below) — and a path relative to it. No window ever learns a real path.',
    entries: [
      { call: "invoke('fs_read_dir', { root, path })", returns: '{ name, isDirectory, isFile, isSymlink }[]', summary: "A folder's entries (names and type only)." },
      { call: "invoke('fs_read_dir_detailed', { root, path })", returns: '{ name, isDirectory, isFile, isSymlink, size, mtimeMs, createdMs }[]', summary: 'Same, with size and both timestamps — one call instead of a `fs_stat` per entry (for sorting/searching a whole folder).' },
      { call: "invoke('fs_stat', { root, path })", returns: '{ isFile, isDirectory, isSymlink, size, mtimeMs }', summary: 'One entry.' },
      { call: "invoke('fs_exists', { root, path })", returns: 'boolean', summary: 'Whether something is there.' },
      { call: "invoke('fs_read_file', { root, path })", returns: 'ArrayBuffer', summary: 'A file’s bytes.' },
      { call: "invoke('fs_write_file', bytes, { headers: { root, path: encodeURIComponent(path) } })", returns: 'void', summary: 'Creates or replaces a file; the bytes are the request body. The parent folder must already exist.', note: 'Byte payloads go through headers, not a JSON body — see `invokeWithBytes` below.' },
      { call: "invoke('fs_mkdir', { root, path, recursive? })", returns: 'void', summary: 'Makes a folder.' },
      { call: "invoke('fs_remove', { root, path, recursive? })", returns: 'void', summary: 'Deletes a file or folder (a link is removed itself, never its target).' },
      { call: "invoke('fs_rename', { root, from, to })", returns: 'void', summary: 'Renames or moves within the file scope.' },
      { call: "invoke('fs_copy', { fromRoot, from, toRoot, to })", returns: 'void', summary: 'Server-side copy, possibly across two roots; refuses to copy a file onto itself.' },
      { call: "invoke('fs_upload_begin', { root, path }) → invoke('fs_upload_chunk', bytes, { headers: { id } }) (repeat) → invoke('fs_upload_finish', { id })", returns: 'the finished file only appears at the end', summary: 'Uploads a browser `File` in 4 MiB pieces so nothing huge sits in memory at once; `fs_upload_abort` cancels one in flight.' },
    ],
  },
  {
    title: 'SQLite',
    intro: 'Our own implementation (not the fs plugin’s): a database is addressed the same way a file is, and the returned handle is a virtual name, never a real path.',
    entries: [
      { call: "invoke('sqlite_load', { root, path })", returns: 'a handle string ("<root>/<path>")', summary: 'Opens (or creates) a .db file in the file scope; the handle only works in this window and closes with it.' },
      { call: "invoke('sqlite_execute', { db, query, values })", returns: '{ rowsAffected, lastInsertId }', summary: 'INSERT/UPDATE/DELETE/DDL.' },
      { call: "invoke('sqlite_select', { db, query, values })", returns: '{ [column]: value }[]', summary: 'A query; BLOBs come back as byte arrays.' },
      { call: "invoke('sqlite_close', { db })", returns: 'void', summary: 'Closes the handle early (it also closes with the window).' },
    ],
  },
  {
    title: 'Windows & tabs',
    intro:
      'A web app runs in a secondary window whose Tauri window label *is* its guid. Tab entries are made by the admin-app side first (opening a window, "new tab", a link followed "in a new tab") — a page only *binds* to the one left pending for it with `init_window_tab`, or creates one itself with `add_window_tab`. See CLAUDE.md’s "Who creates tabs" for the full rule.',
    entries: [
      { call: "invoke('init_window_tab', { appVersion, url, resourceType? })", returns: '{ tabGuid, resourceId, codeSnippets, relativePath, openedBy, storage, filen? }', summary: 'Binds this page to the tab already waiting for it. Never creates one — call this once as the page loads, after attaching the `tab-navigate` listener below.' },
      { call: "invoke('add_window_tab', { appVersion, url, resourceType? })", returns: 'same shape as `init_window_tab`', summary: 'Adds a *new* tab for another resource in this window and makes it current — the only way a page creates a tab itself.' },
      { call: "getCurrentWebviewWindow().listen('tab-navigate', (event) => { … event.payload … })", returns: 'an unlisten function', summary: 'Fired when the person switches to another tab of this window; the payload is what `init_window_tab` returns. Listen on *this* window only, never the global `listen` (which also hears events meant for other windows) — and attach it before calling `init_window_tab`, or a switch made in the moment between could be missed.', note: 'Without a handler, reloading the page (`location.reload()`) is the correct default reaction.' },
      { call: "invoke('update_tab_resource', { tabGuid, tabText?, resourceType?, resourceId?, appTitle? })", returns: 'void', summary: 'Sets the tab’s two-line label (`tabText: { firstRow, secondRow }`, each a list of `{ text, bold?, italic?, mono? }`) and/or the window title (`appTitle`); omitted fields are left as they were, but the label is *replaced* by every call — send it every time.' },
      { call: "invoke('activate_tab', { tabGuid })", returns: 'void', summary: 'Shows a tab (opening its window first if it isn’t open); an *open* window is sent `tab-navigate` and shown in place, not reloaded.' },
      { call: "invoke('close_tab', { tabGuid })", returns: 'void', summary: 'Removes a tab and its tags; if it’s the tab an *open* window is showing, that window is suspended (its other tabs are kept).' },
      { call: "invoke('reload_tab', { tabGuid })", returns: 'void', summary: 'The same as `location.reload()` in the window currently showing that tab; keeps the page’s scroll position.' },
      { call: "getCurrentWebviewWindow().listen('show-top-bar', () => { … })", returns: 'an unlisten function', summary: 'The person asked, from the admin-app, for this window to show its own top bar — a tab’s own row in the System/User Apps tabs, or Settings’ "Show the top bar for every open window". Only a page that draws a header of its own (see the `example-toolbar` sample) needs to listen for this — nothing calls it automatically, and there is no command a page can use to trigger it on itself.' },
      { call: "invoke('create_tab_group', { windowGuid })", returns: 'a tab group record', summary: 'Makes a new tab group in a window.' },
      { call: "invoke('rename_tab_group', { guid, name })", returns: 'void', summary: '' },
      { call: "invoke('add_blank_tab', { groupGuid })", returns: 'a tab record', summary: 'A new, unbound tab in a group.' },
      { call: "invoke('clone_tab', { tabGuid })", returns: 'a tab record', summary: 'A copy of a tab, same group.' },
      { call: "invoke('delete_tab_group', { groupGuid })", returns: 'void', summary: 'Removes a group with its tabs and their tags.' },
      { call: "invoke('move_tab_to_group', { tabGuid, targetGroupGuid })", returns: 'void', summary: 'Only between windows of the *same* app (same `relativePath`).' },
      { call: "invoke('list_secondary_windows', { kind })", returns: 'window records (with their tab groups/tabs)', summary: "`kind` is `'user'` or `'system'`." },
      { call: "invoke('open_new_secondary_window', { kind, relativePath })", returns: 'a window record', summary: 'Opens a window for a page of this app (or brings an already-open one to the front).' },
      { call: "invoke('add_secondary_window_entry', { kind, relativePath })", returns: 'a window record', summary: 'Registers an entry without opening a window (it shows as suspended).' },
      { call: "invoke('reopen_secondary_window', { guid })", returns: 'void', summary: 'Opens a suspended window’s entry, showing the tab it showed before.' },
      { call: "invoke('suspend_secondary_window', { guid })", returns: 'void', summary: 'Closes only the window — the entry, its tab groups/tabs and tags stay.' },
      { call: "invoke('close_secondary_window', { guid })", returns: 'void', summary: 'Closes the window *and* removes its entry (works on a suspended one too).' },
      { call: "invoke('suspend_all_secondary_windows', { kind?, relativePath? })", returns: 'void', summary: '' },
      { call: "invoke('close_all_secondary_windows', { kind?, relativePath? })", returns: 'void', summary: '' },
      { call: "invoke('focus_secondary_window', { guid })", returns: 'void', summary: 'Brings an already-open window to the front.' },
      { call: "invoke('reload_secondary_window', { guid })", returns: 'void', summary: 'Reloads whichever tab an open window is currently showing.' },
      { call: "invoke('list_system_apps')", returns: '{ id, name }[]', summary: 'The catalog of system apps (Notes and any future ones) — shows even before any of them has a window.' },
      { call: "invoke('root_guid', { root })", returns: 'a guid string', summary: 'A stable id for a root (the user folder or a picked folder), made the first time it’s asked for.' },
    ],
  },
  {
    title: 'Tags',
    intro: 'Tags attach to any stable guid — a window, a tab group, a tab, or (in the Files tab) a file-manager root, keyed `root:<rootId>`.',
    entries: [
      { call: "invoke('list_tags', { guids })", returns: 'tag records', summary: 'Every tag of the given guids, in order.' },
      { call: "invoke('add_window_tag', { guid, text, fgColor, bgColor })", returns: 'the new tag', summary: 'Added last.' },
      { call: "invoke('update_window_tag', { id, text, fgColor, bgColor })", returns: 'void', summary: '' },
      { call: "invoke('reorder_window_tags', { guid, ids })", returns: 'void', summary: '`ids` in the new order.' },
      { call: "invoke('remove_window_tag', { id })", returns: 'void', summary: '' },
    ],
  },
  {
    title: 'External web sites',
    intro: 'A page of the web (http/https) shown in a window of this app, one confirmed OS box at a time — see CLAUDE.md’s "External web sites".',
    entries: [
      { call: "invoke('open_external_site', { url })", returns: 'a request id', summary: 'Asks (native confirmation box: who’s asking, the address, Open/Cancel) to open an http/https site in a window of this app. The answer arrives as an event, not the resolved promise.', note: 'One such request waits for the person at a time; a second call meanwhile is refused.' },
      { call: "getCurrentWebviewWindow().listen('external-site-response', (event) => { … })", returns: 'an unlisten function', summary: 'Payload: `{ requestId, url, confirmed, pageGuid, error }` — sent only to the window that asked.' },
      { call: "getCurrentWebviewWindow().listen('external-site-changed', (event) => { … })", returns: 'an unlisten function', summary: 'Payload: `{ pageGuid, url, initialUrl, title }` — the site’s own address or title changed.' },
      { call: "getCurrentWebviewWindow().listen('external-site-closed', (event) => { … })", returns: 'an unlisten function', summary: 'Payload: `{ pageGuid }` — its window was closed (the entry stays, suspended).' },
      { call: "invoke('reopen_external_site', { guid })", returns: 'void', summary: '' },
      { call: "invoke('focus_external_site', { guid })", returns: 'void', summary: '' },
      { call: "invoke('suspend_external_site', { guid })", returns: 'void', summary: '' },
      { call: "invoke('close_external_site', { guid })", returns: 'void', summary: '' },
    ],
  },
  {
    title: 'Filen.io (a connected account, live)',
    intro: 'Paths are absolute Filen paths (`/`, `/Folder/file.txt`). No credential ever reaches a window — connecting/disconnecting an account is the admin-app’s alone.',
    entries: [
      { call: "invoke('filen_list_accounts')", returns: '{ userId, email }[]', summary: 'The connected accounts.' },
      { call: "invoke('filen_readdir', { userId, path })", returns: '{ name, isDirectory, size, mtimeMs }[]', summary: '' },
      { call: "invoke('filen_stat', { userId, path })", returns: 'one entry', summary: '' },
      { call: "invoke('filen_read_file', { userId, path })", returns: 'ArrayBuffer', summary: '' },
      { call: "invoke('filen_write_file', bytes, { headers: { userId: String(userId), path: encodeURIComponent(path) } })", returns: 'void', summary: 'Creates or replaces.' },
      { call: "invoke('filen_mkdir', { userId, path })", returns: 'void', summary: 'Recursive.' },
      { call: "invoke('filen_rm', { userId, path })", returns: 'void', summary: 'To Filen’s trash.' },
      { call: "invoke('filen_rename', { userId, from, to })", returns: 'void', summary: 'Also moves.' },
    ],
  },
  {
    title: 'The Filen cache (offline-aware, with branches)',
    intro:
      'A cached, branchable alternative to the live Filen calls above — the same idea Notes uses for its own file manager (see CLAUDE.md’s "The Filen cache"). Most of it is granted to every window; only `filen_cache_hard_refresh`/`filen_cache_clear_item` are actually in the plain web-app grant besides the account/listing/branch commands below, which are all included.',
    entries: [
      { call: "invoke('filen_cache_account', { userId })", returns: 'account cache info', summary: '' },
      { call: "invoke('filen_cache_set_interval', { userId, ttlSecs })", returns: 'void', summary: '`null` disables expiry (offline-available).' },
      { call: "invoke('filen_cache_clear', { userId })", returns: 'void', summary: 'Clears the whole cache of the account.' },
      { call: "invoke('filen_cache_list', { userId, path, branch?, force? })", returns: 'entries (cached, or fetched if stale)', summary: '' },
      { call: "invoke('filen_cache_read', { userId, path, branch? })", returns: 'bytes', summary: 'For files small enough to hold in memory (≤ 2 MB, matching Notes’ own editor limit).' },
      { call: "invoke('filen_cache_write', bytes, { headers: { userId, path, branch? } })", returns: 'void', summary: '' },
      { call: "invoke('filen_cache_hard_refresh', { userId, path, branch? })", returns: 'void', summary: 'Fetches again from Filen, replacing the cache.' },
      { call: "invoke('filen_cache_clear_item', { userId, path, branch? })", returns: 'void', summary: 'Throws away the cache of one item (and everything below it, for a folder).' },
      { call: "invoke('filen_cache_mkdir'/'filen_cache_rm'/'filen_cache_rename', { … })", returns: 'void', summary: 'Same shapes as the plain Filen commands, but cache/branch-aware.' },
      { call: "invoke('filen_cache_branches', { userId })", returns: 'branch records', summary: '' },
      { call: "invoke('filen_cache_create_branch', { userId, name })", returns: 'the new branch', summary: '' },
      { call: "invoke('filen_cache_branch_changes', { userId, branch })", returns: 'pending changes', summary: '' },
      { call: "invoke('filen_cache_commit_branch', { userId, branch, force? })", returns: 'void, or the conflicts', summary: 'Applies the branch to Filen; refuses on conflict unless `force`.' },
      { call: "invoke('filen_cache_discard_branch', { userId, branch })", returns: 'void', summary: '' },
      { call: "invoke('filen_cache_version'/'filen_cache_check_version'/'filen_cache_rebase', { … })", returns: 'version info', summary: 'Detects a file changed elsewhere before you save over it.' },
      { call: "invoke('filen_cache_set_locked', { userId, path, locked })", returns: 'void', summary: 'A locked file keeps its frozen copy, available offline, immune to refresh/expiry.' },
      { call: "invoke('filen_cache_checkout'/'filen_cache_release', { … })", returns: 'void', summary: 'Takes a file into a branch without changing it yet, or lets go of one that was never changed.' },
      { call: "invoke('filen_cache_upload_begin'/'_chunk'/'_finish'/'_abort', { … })", returns: 'a session id, then void', summary: 'Chunked upload into the cache/a branch (mirrors `fs_upload_*`).' },
      { call: "invoke('filen_cache_thumb_get'/'filen_cache_thumb_put', { … })", returns: 'a JPEG, or void', summary: '' },
    ],
  },
  {
    title: 'Branches of a folder of this device',
    intro: 'The same branch idea as the Filen cache, but for the user folder or a picked folder — there is no cache here, just local changes kept apart until committed. See `local_branch_commands.rs`.',
    entries: [
      { call: "invoke('local_branches', { root })", returns: 'branch records', summary: '' },
      { call: "invoke('local_branch_create', { root, name })", returns: 'the new branch', summary: '' },
      { call: "invoke('local_branch_discard', { root, branch })", returns: 'void', summary: '' },
      { call: "invoke('local_branch_changes', { root, branch })", returns: 'pending changes', summary: '' },
      { call: "invoke('local_branch_commit', { root, branch, force? })", returns: 'void, or the conflicts', summary: '' },
      { call: "invoke('local_branch_list'/'_read'/'_write'/'_mkdir'/'_rm'/'_rename', { root, branch, … })", returns: 'varies', summary: 'Read/write through the branch’s view of the folder.' },
      { call: "invoke('local_branch_version'/'_check_version'/'_rebase', { … })", returns: 'version info', summary: '' },
      { call: "invoke('local_branch_checkout'/'_release', { … })", returns: 'void', summary: '' },
      { call: "invoke('local_thumb_get'/'local_thumb_put', { … })", returns: 'a JPEG, or void', summary: '' },
    ],
  },
  {
    title: "The app's clipboard",
    intro: 'One text, kept by the backend and shared by every window of the app (not persisted; nothing copied to it reaches the OS clipboard). Any window may read and write it.',
    entries: [
      { call: "invoke('internal_clipboard_get')", returns: 'string', summary: '' },
      { call: "invoke('internal_clipboard_set', { text })", returns: 'void', summary: '16 MiB at most.' },
      { call: "invoke('internal_clipboard_clear')", returns: 'void', summary: '' },
    ],
  },
  {
    title: 'Appearance',
    intro: 'The theme and light/dark mode are one choice for the whole app.',
    entries: [
      { call: "invoke('get_appearance')", returns: '{ theme, mode, rotation }', summary: '' },
      { call: "invoke('list_themes')", returns: 'theme ids, in the catalog’s order', summary: '' },
      { call: "invoke('set_appearance', { theme, mode })", returns: 'void', summary: 'Any window may call this.' },
      { call: "getCurrentWebviewWindow().listen('appearance-changed', (event) => { … })", returns: 'an unlisten function', summary: 'Payload: `{ theme, mode, dark, rotation }`. A web app keeps its own colours but may follow the mode or the theme.' },
    ],
  },
  {
    title: 'App state & global settings',
    intro: 'Per-app key/value storage in the shared database, namespaced automatically by the calling app — an app only ever reaches its own state. Belongs in `data.db` for anything the app itself needs to remember, never `localStorage`/IndexedDB (see CLAUDE.md’s "App state storage").',
    entries: [
      { call: "invoke('get_app_state', { key })", returns: 'a JSON string, or null', summary: 'Parse it yourself.' },
      { call: "invoke('set_app_state', { key, value })", returns: 'void', summary: '`value` is a JSON string you build yourself (e.g. `JSON.stringify(...)`).' },
      { call: "invoke('get_window_state', { key })", returns: 'a JSON string, or null', summary: 'Like `get_app_state`, but scoped to *this window* only — gone when its entry is.' },
      { call: "invoke('set_window_state', { key, value })", returns: 'void', summary: '' },
      { call: "invoke('get_global_setting', { key })", returns: 'a string, or null', summary: 'The few preferences shared by every app (today: the list page size, `listPageSize`). Not for app-specific settings.' },
      { call: "invoke('set_global_setting', { key, value })", returns: 'void', summary: 'Refuses every `appearance.` key (the admin-app alone sets the theme rotation).' },
    ],
  },
  {
    title: 'Picked folders',
    intro: 'A folder the person chooses with a native picker, beyond the user folder — addressed by an opaque id from then on, exactly like the user folder’s `"user"`.',
    entries: [
      { call: "invoke('pick_folder')", returns: '{ id, label } or null', summary: 'Opens the OS folder dialog (or `FolderPicker.kt` on Android); `null` if the person cancelled. One prompt at a time, like every native box.' },
      { call: "invoke('list_picked_roots')", returns: '{ id, label }[]', summary: 'The folders picked in earlier sessions (remembered, allowed again at every start).' },
      { call: "invoke('remove_picked_root', { id })", returns: 'void', summary: 'Revokes access at once.' },
    ],
  },
  {
    title: 'Exporting to the device',
    intro: 'Every window may export a file to the device — the person is asked every time (a native "save as" on desktop, a confirmation before writing to Downloads on Android).',
    entries: [
      { call: "invoke('choose_save_location', { name })", returns: 'a one-time token, or null (desktop only)', summary: 'The native "save as" dialog; read the file’s bytes only after this resolves.' },
      { call: "invoke('save_to_device', bytes, { headers: { name, token? } })", returns: 'void', summary: 'Writes the bytes (the request body) under `name` — with the desktop token, or straight to Downloads with an Android confirmation.' },
    ],
  },
  {
    title: 'Dialogs',
    intro: 'Native boxes under the app’s own prompt rules (one at a time, counted, refusable by "Prevent this app from showing prompts") — not the browser’s own `confirm`/`alert`, which are intercepted and rerouted through these same rules automatically.',
    entries: [
      { call: "invoke('confirm_dialog', { message })", returns: 'boolean', summary: 'A yes/no box; the title says which window/page is asking. At most 1500 characters.' },
      { call: "invoke('alert_dialog', { message })", returns: 'void', summary: '' },
    ],
  },
  {
    title: 'Code snippets',
    intro: 'Small platform fixes the backend hands every web app (e.g. padding for Android’s system bars) — apply them once on load and again from `tab-navigate`/`init_window_tab`’s response.',
    entries: [
      { call: "invoke('get_code_snippets')", returns: '{ code, type }[]', summary: '`type` is `"css"`, `"html"` or `"javascript"`. `init_window_tab`/`add_window_tab`/`tab-navigate` already include the current list — this is for fetching it before any of those (e.g. right on load).' },
    ],
  },
  {
    title: 'Notes-only helpers',
    intro: 'Granted to every window, but only meaningful for a page that a Notes tab opened (or that opens another page itself) — see CLAUDE.md’s "Web apps opened from Notes".',
    entries: [
      { call: "invoke('open_file_as_web_app', { file })", returns: 'the new window’s guid', summary: 'Opens an html/markdown file as a web app of its own.' },
      { call: "invoke('open_related_web_app', { path })", returns: 'the new window’s guid', summary: 'From a page opened via Notes: opens a sibling file (relative to this page’s own address) with the same parent tab.' },
      { call: "invoke('media_url', { file })", returns: 'a URL', summary: 'The address to load a picture/video/sound at — the file is never read into the page itself.' },
      { call: "invoke('open_note_tab', { file, sync, newWindow? })", returns: 'the tab’s guid', summary: 'Opens a note’s markdown as a web app; `sync` makes it the note’s one syncing tab, reused on the next click.' },
      { call: "invoke('notify_file_saved', { file })", returns: 'void', summary: 'Admin-app/system apps only — reloads any syncing tab showing that file.' },
    ],
  },
]
