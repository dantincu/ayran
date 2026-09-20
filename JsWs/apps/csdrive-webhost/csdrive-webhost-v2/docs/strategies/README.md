# Strategies

Short write-ups (Markdown) of *how* we do recurring things in this app, so the same problem is always solved the same way.
Add a file here for each new strategy, and point to it from the code that implements it.

- [Folder Pairs Strategy](folder-pairs-strategy.md) — giving a thing (a cached account, a branch, a note, …) a home on disk as a short data
  folder plus a readable sibling holding only a `.keep` file; how the numbers (intervals, prefixes, constants) are chosen.
- [Notes Strategy](notes-strategy.md) — how notes, note children and notebooks are persisted: the files a note has, the notebook's
  `[note-book].json`, how names are made from titles, how indexes are normalised.
- [Android Windows Strategy](android-windows-strategy.md) — one real window (an activity of its own) per web app / system app on Android,
  with a bridge of our own to the backend.
