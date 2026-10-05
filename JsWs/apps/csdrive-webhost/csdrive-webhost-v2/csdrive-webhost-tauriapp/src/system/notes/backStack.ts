/** A single, process-wide stack of "undo one step" callbacks for Notes' own in-app navigation — folder
 * browsing, opening/closing the file editor or the media viewer (`NotesApp.tsx`), and switching between the
 * home page, notebooks, settings, a note and its editor (`NotesRoot.tsx`) — so `NotesTopBar`'s one "Go back
 * one step" button can undo the last of any of these without knowing which component made it.
 *
 * This is deliberately separate from `windowGoBack`/`window_go_back` (the backend command that undoes a
 * *tab switch* or a link followed "in this tab" — see CLAUDE.md's "Back undoes one navigation before it ever
 * suspends"): that one undoes something the *admin-app* did to the window from outside; this one undoes
 * something the page itself did in response to the person clicking around inside Notes. `NotesTopBar` tries
 * this stack first and falls back to the backend command only once it's empty, so both kinds of "back" work
 * through the one button without either shadowing the other.
 *
 * **Why a single stack works even though two different components push onto it** (`NotesRoot`'s own `place`,
 * and `NotesApp`'s own `path`/`editing`/`viewer`): entries are pushed in the same order the real navigation
 * happened, so popping them undoes it in reverse — an entry belonging to an inner component (a folder opened
 * inside the file manager) is pushed *after*, and popped *before*, the entry that caused that inner component
 * to mount in the first place (entering the file manager from the home page).
 *
 * **A component can leave itself while some of its own entries are still un-popped** (`NotesApp`'s own "Notes
 * home" button, say) — those entries must not linger, pointing at an instance that's about to be gone (a pop
 * that reached one would call a dead component's `setState`, which React quietly does nothing with, making
 * the button look like it had simply stopped working). [`pushOwned`]/[`discardOwner`] exist for exactly this:
 * a component tags every entry it pushes with one id (a fresh `Symbol()` made once, at mount) and discards
 * all of them, by that tag, on unmount — **not** by truncating the stack to a remembered length. Truncating
 * would also be wrong here: the very same navigation that unmounts the component (`NotesRoot`'s own `navigate`
 * to another view) pushes *its own* entry **before** the unmount actually happens, so by the time cleanup
 * runs, that fresh, valid entry already sits on top of the inner component's stale ones — a plain
 * length-based cutoff would discard it right along with them. Filtering by owner removes only what the
 * leaving component actually pushed, wherever it ended up, and leaves every other entry — including one
 * pushed a moment earlier by the very transition that's leaving it — exactly where it was.
 *
 * **The one case that isn't caused by a `pushBack`/`pushOwned` call at all** — an *external* tab switch
 * (`activate_tab`, from the admin-app) — is handled by [`clearBack`]: whatever was accumulated before it
 * doesn't describe a sensible "undo" for a switch nothing in this stack caused, and `windowGoBack` already
 * undoes that switch itself. */

interface Entry {
  undo: () => void
  owner?: symbol
}

let stack: Entry[] = []

export function pushBack(undo: () => void) {
  stack.push({ undo })
}

/** Like [`pushBack`], tagged with `owner` so [`discardOwner`] can later remove just this component's own
 * entries without disturbing anything else on the stack. */
export function pushOwned(undo: () => void, owner: symbol) {
  stack.push({ undo, owner })
}

/** Undoes the last step and returns `true`, or does nothing and returns `false` when there is none — the
 * signal `NotesTopBar` uses to fall back to `windowGoBack`. */
export function popBack(): boolean {
  const entry = stack.pop()
  if (!entry) return false
  entry.undo()
  return true
}

/** Called on an external tab switch — nothing accumulated before it is a sensible "back" any more. */
export function clearBack() {
  stack = []
}

/** Removes every entry tagged with `owner` (see [`pushOwned`]) — called when the component that owns them
 * unmounts, so a later "Go back" can never reach one of its stale closures. */
export function discardOwner(owner: symbol) {
  stack = stack.filter((e) => e.owner !== owner)
}
