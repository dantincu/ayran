# Folder Pairs Strategy

How CsDrive WebHost gives *a thing* — a cached Filen account, a branch, and whatever comes next — a home on disk.
It is used a lot, and it is central to the Notes app, so it lives in one place:
`csdrive-webhost-tauriapp/src-tauri/src/folder_pairs.rs`. Everything that needs a pair goes through that module.

## The idea

A thing gets **a pair of sibling folders** inside a parent folder:

| | name | holds | why |
|---|---|---|---|
| **short folder** | `NNN` | the thing's actual data | short, so deep paths stay inside the operating systems' length limits (Windows' 260 characters in particular) whatever the readable name is |
| **full folder** | `NNN-<full name part>` | only a `.keep` file (see "Preserving empty folders") | so a person browsing the disk can tell which short folder is which |

`NNN` is the pair's **index**: at least three digits, left-padded with zeros — `001`, `042`, `1000`.
The full name part is chosen by the caller (see below) and is separated from the index by a dash.

Example, for a Filen account with the email `me@example.com` and the id `3141`:

```
files/a/
  001/                                  <- data lives in here
  001-filen@@me@example.com@@3141/      <- only says what 001 is
    .keep                               <- the one-dash file that keeps the folder from being empty
```

## Choosing the index

There is **no counter to keep in sync**. The disk is the source of truth:

1. list the entry names in the parent folder;
2. keep those that start with **three or more digits and a dash** — that is, only the *full* folders (a short folder has no dash);
3. parse the digits as integers — these are the indexes **in use**;
4. pick the new index from them, by the **`Indexing`** option the caller passes:

| `Indexing` | the new pair gets | with `001` and `003` in use | with none in use |
|---|---|---|---|
| `AfterLargest` | the largest index in use **plus one** | `004` | `001` |
| `FillGaps` | the **lowest index, from 1, that isn't in use** | `002` (then `004`) | `001` |

**Everything the app creates today uses `FillGaps`** — accounts and branches — so deleting a pair leaves no permanent hole in the
numbering. (`AfterLargest` remains for callers that want indexes never to be reused below the newest pair.)

Consequences worth knowing:

- deleting a pair is just deleting its two folders — nothing else to update;
- with `AfterLargest`, gaps are **not** filled, and an index freed by deleting the *newest* pair is the only one that comes back;
- with `FillGaps`, **every** freed index comes back, so an index is *not* a permanent name for one thing: anything that remembers
  an index (for instance a Notes tab's resource id naming a branch by its index) can end up pointing at a *newer* pair that took it;
- with `FillGaps`, a bare short folder `NNN` with no full folder beside it (a pair whose marker went missing) also counts as in
  use, so the new pair's short folder can never collide with it;
- above 999 the index simply gets longer (`1000`); the rule "three or more digits" keeps parsing correct.

## Choosing the full name part

The part is up to the caller, with one rule: it must be a valid file name on every platform (no `< > : " / \ | ? *`,
no control characters, no trailing dot or space, at most **100 characters**, and not a name Windows reserves such as `CON`).

- **Accounts** (`files/a`, `files/b`) — `filen@@<email>@@<account id>`: the storage provider, the account's email address and the
  provider's account id, separated by `@@`. It is built by the code, and characters that aren't allowed in a file name are
  replaced by `_` (`sanitize_part`).
- **Branches** (inside an account's short folder in `files/b`) — the **name the user gave the branch**, used as it is. It is
  validated when they type it (`validate_part`) rather than sanitised, so what they see is what is on disk.

## Preserving empty folders

The whole idea behind creating such pairs of folders is based on the idea that the 2 folders will always be visible and sitted next to each other in any file manager / file browser view. That includes mapping and mirroring pairs of folders from cloud storage to local disk and vice versa, or when archiving the pairs of folder then unarchiving them elsewhere. In both cases empty folders could be lost at the destination. In our case the full name folder would normally be left empty. To avoid that, we'll always add inside the full name folder a text file called ".keep". Even an empty text file is problematic (some cloud storage systems ignore them). So let's put a constant string in these .keep files: "-" (yes, 1 character: the dash).

**How it is done.** `folder_pairs::KEEP_FILE` (`.keep`) and `KEEP_CONTENT` (`-`, one character, no line break). `create` writes it into the
full folder it makes; `ensure` puts it back if a pair lacks it (or holds anything else); `repair(parent)` gives it to every pair in a
parent that lacks one and says how many it wrote. **Retroactively:** pairs made before the rule have empty full folders, so the Filen cache
runs `repair` over `files/a`, `files/b` and each account's branches every time it opens (at each start) — the rule is *always* true, not
only for new pairs. (The one pair already on the development machine, in the default app data folder, was also marked by hand.) The short
folders are never touched: they are the data's.

## Operations (`folder_pairs.rs`)

| function | does |
|---|---|
| `next_index(parent, indexing)` | the index the next pair would get |
| `create(parent, part, indexing)` | creates the parent if needed, then both folders |
| `find(parent, part)` | the pair whose full name part is exactly `part`, if any |
| `ensure(parent, part, indexing)` | `find`, or `create`; also repairs a missing short folder or `.keep` |
| `repair(parent)` | gives every pair in `parent` its `.keep` if it lacks one; returns how many it wrote |
| `list(parent)` | every pair, by index |
| `delete(parent, part)` | deletes both folders and everything in the short one |
| `sanitize_part(text)` / `validate_part(name)` | see above |

Callers that could race must serialise their use (the Filen cache does, with one lock).

## Where it is used

All with `FillGaps` (`files_cache::INDEXING`):

- `files/a/` — one pair per connected Filen account. Inside the short folder, `c/` mirrors the account's files and folders
  (only what has been opened or exported — a cache, not a sync). The pair is deleted when the account is disconnected.
- `files/b/` — one pair per account that has branches. Inside the account's short folder, one pair per branch, and inside a
  branch's short folder the files the branch has changed. A branch's pair is deleted when it is committed or discarded; the
  account's pair goes with the account.

See `CLAUDE.md`, "Notes and the Filen cache", for how those work.
