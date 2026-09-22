# Folder Pairs Strategy

How Ayran CsDrive WebHost gives *a thing* — a cached Filen account, a branch, and whatever comes next — a home on disk.
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

*(This is the default numbering — no prefix, upward from `001`, three digits, first free. The next section is the general form.)*

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

## Generalising the way the index is computed:

Everything above describes **one numbering**, the default one. A numbering is three things: a **prefix**, an **interval** of indexes and an
**`Indexing`** option. (`folder_pairs::Numbering`; `Numbering::DEFAULT` is the one the app's own pairs use.)

**The interval.** Where the indexes come from is configurable: a start, an end and — by which of the two is larger — a *direction*, plus how many
digits the index is written with. `1`–`999` going up with three digits is the default (in fact without an upper end: above `999` the index just gets
longer). `999`–`401` going *down* is just as good, and `01`–`09` going up with two digits too. An interval of a **single index** is a *constant*:
a pair that has a fixed number instead of a computed one (`ensure` makes it once and finds it after; it refuses if another pair holds the number).
Only the indexes *inside* the interval count as in use, so **several numberings can share one parent folder**, each owning its own interval —
as long as the intervals don't overlap (nothing checks; it is the definition of the numberings that must keep them apart). An interval that is full
is an error (`No free index from 999 to 401 in …`), never a wrap-around.

**The option flag (`Indexing`)** picks among the free indexes *of the interval*, in its direction:

| `Indexing` | a new pair gets | descending `999`–`401`, with `999` and `997` in use | ascending `001`–`999`, with `001` and `003` in use |
|---|---|---|---|
| `FillGaps` (*first free*) | the first index nobody uses, walking from the interval's start | `998` (then `996`) | `002` (then `004`) |
| `AfterLargest` | one step past the furthest index in use (the start if none) | `996` | `004` |

`AfterLargest` refuses when nothing lies beyond the furthest index even if there are gaps behind it (`FillGaps` would find them). Today's callers
— cached accounts and branches — use `FillGaps`; the Notes app's persisted notes will use `AfterLargest`, so that the order of creation is the
order of the numbers.

**The prefix.** Optionally a constant string is prepended to the names of *both* folders of a pair: `<prefix>NNN` and `<prefix>NNN-<full name part>`.
The default is the empty string. It must be valid in a file name and must not begin with a digit (it would blur where the index starts). Only pairs
with the numbering's own prefix are its pairs, so the same parent can hold, say, `005-x` and `t_005-x` without either being taken for the other.

**The temporary prefix** (`TEMPORARY_PREFIX`, `"t_"`) is for **mass renumbering**, e.g. many notes getting new indexes at once. Renaming them one at a
time would collide — a new name is very often an old one that hasn't moved yet (shifting a run of notes by one, swapping two) — so it is done in two
phases: first **every pair to be moved is renamed to the temporary prefix** (same index), and only then **every one is renamed to its final
name** from its new index. `folder_pairs::reassign(parent, from, to, moves)` does exactly that, and checks everything it can *before the first
rename*: the new indexes are distinct and inside `to`'s interval, and no folder that isn't one of the moving pairs holds a new or a temporary name.
A single pair is renamed whole or not at all (`rename`: if the second folder can't move, the first goes back). If a rename fails midway, the pairs
that got that far keep the temporary prefix; list them with `from.temporary()` and call `reassign` again with that as `from` — the first phase then has
nothing to do.

**Parsing names.** A name is a full folder of a numbering when it has the numbering's prefix, then the index *written the way that numbering
writes it* — padded to its digit count, no extra zeros, so `001` is not a two-digit numbering's `01` — then a dash; whether the index is in the
numbering's interval decides whether the pair is *its*. With the note system's intervals that is easy to see by eye:

| kind | interval | digits | example |
|---|---|---|---|
| note items (the default kind) | `999` → `401`, descending | 3 | `999-…` |
| primary note sections | `199` → `111`, descending | 3 | `199-…` |
| secondary note sections | `299` → `201`, descending | 3 | `299-…` |
| ternary note sections | `399` → `301`, descending | 3 | `399-…` |
| internal folder pairs | the constants `1`, `2`, `3` (not computed) | 2 | `01-[note-files]`, `02-[note-internals]`, `03-[note-book]` |

A name with **two digits** can only be one of the internal pairs; one with **three digits** is a note item or a section, told apart by the interval its
index falls in (`999`–`401` an item, `399`–`301` a ternary section, `299`–`201` a secondary one, `199`–`111` a primary one). The "full name part" of the
internal pairs is a fixed string in brackets, which is fine — it is whatever comes after the first dash.

**Where the numberings are defined.** `folder_pairs.rs` holds the *mechanism* only — `Interval`, `Indexing`, `Numbering`, the temporary prefix,
`rename`, `reassign` — and knows nothing about notes. **The constants themselves are in one config file**, `csdrive-webhost-tauriapp/config/folder-pairs-and-notes.json`,
compiled into the backend (`config.rs`) and bundled into the frontend (`appConfig.ts`): the `.keep` file and its content, the temporary prefix,
the longest name part, the default numbering (this app's cached accounts and branches, `config::DEFAULT_NUMBERING`) and the note system's
intervals from the table above (they are used by the Notes app's own code, `noteIndexes.ts`, which does the same arithmetic in the frontend). A test
checks that the intervals don't overlap.

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

Methods of `Numbering` (the parent folder is always the first argument):

| method | does |
|---|---|
| `next_index(parent)` | the index the next pair would get (an error if the interval is full) |
| `create(parent, part)` | creates the parent if needed, then both folders and the `.keep` |
| `find(parent, part)` | the pair of this numbering whose full name part is exactly `part`, if any |
| `ensure(parent, part)` | `find`, or `create`; also repairs a missing short folder or `.keep` |
| `list(parent)` | every pair of this numbering (its prefix, its interval), by index |
| `delete(parent, part)` | deletes both folders and everything in the short one |
| `repair(parent)` | gives every pair its `.keep` if it lacks one; returns how many it wrote |
| `short_name(index)` / `full_name(index, part)` / `parse(name)` | the names, and reading them back |

Free functions: `rename(parent, pair, to, index)` (one pair, whole or not at all), `reassign(parent, from, to, moves)` (many, two phases through the
temporary prefix), `sanitize_part(text)` / `validate_part(name)` (see above).

Callers that could race must serialise their use (the Filen cache does, with one lock).

## Where it is used

All with `Numbering::DEFAULT` — first free (`files_cache::NUMBERING`):

- `files/a/` — one pair per connected Filen account. Inside the short folder, `c/` mirrors the account's files and folders
  (only what has been opened or exported — a cache, not a sync). The pair is deleted when the account is disconnected.
- `files/b/` — one pair per account that has branches. Inside the account's short folder, one pair per branch, and inside a
  branch's short folder the files the branch has changed. A branch's pair is deleted when it is committed or discarded; the
  account's pair goes with the account.

See `CLAUDE.md`, "Notes and the Filen cache", for how those work.
