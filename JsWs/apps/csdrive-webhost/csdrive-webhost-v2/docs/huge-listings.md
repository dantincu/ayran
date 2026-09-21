# Huge directory listings

*What happens when a folder has more entries than the app's memory comfortably holds, where the limits are, and what to do about it. Written
after measuring the desktop app; numbers marked **estimate** are extrapolated, not measured.*

## What a listing does today

A folder's listing is **one message**: the backend collects every entry, turns them into JSON, and the page parses that into an array. Only the
page on screen is rendered (lists are paginated on the client), but **all** the entries exist at once in every layer they pass through:

| Layer | Local folder (`fs_read_dir`) | Filen account (cache) |
| --- | --- | --- |
| Where the entries come from | one OS directory scan | **one** request, `/v3/dir/content`, that answers with *every* file and folder of the folder, each with its metadata encrypted inline |
| Rust | `Vec` of entries | the whole response parsed at once, decrypted, then every entry written to the cache's SQLite (`entries`) |
| IPC | one JSON string | one JSON string (`filen_cache_list`, `filen_readdir`) |
| Webview | one array of objects in React state; sorted whole | same |

Since ids were added (`Entry.id`, the cache's `remote_id`), each Filen entry also carries its uuid.

## What it costs (measured, desktop, 100 000 entries in one folder)

| Names | `fs_read_dir` time | JSON as sent | JS heap for the array | sort |
| --- | --- | --- | --- | --- |
| 20 characters, ASCII | 0.6 s | 8.4 MB (84 B per entry) | +23 MB (about 230 B per entry) | 20 ms |
| 100 characters, Chinese | 2.1 s | about 36 MB on the wire in UTF-8 (a CJK character is 3 bytes; 16.4 M UTF-16 characters as a JS string) | +42 MB (about 420 B per entry: JS keeps such strings as UTF-16) | 70 ms |

The listing itself is linear. Extrapolated to a million entries (**estimate**): ASCII names 6 s, 84 MB of JSON, ~230 MB of heap; Chinese names 21 s,
~360 MB of JSON, ~420 MB of heap. Those are *per layer* and they overlap — while the message is being made the backend holds the `Vec` **and** the
JSON, then the webview holds the string **and** the array — so the peak is roughly three times the JSON: **~0.5 GB (ASCII) to ~1.2 GB
(Chinese) for a million entries**.

### Where it becomes a problem

- **Desktop**: up to about 100 000 entries nothing is noticeable (under a second for ASCII names). Around **300 000–500 000** the wait is seconds
  and the memory hundreds of MB, but it works. At **about a million** (20-character names) or **a few hundred thousand** (100-character
  non-ASCII names) it is slow enough (tens of seconds) and large enough (a gigabyte at the peak) to be a real risk of an out-of-memory
  failure in the webview.
- **Android** (**estimate**): the message goes through the window bridge as a string evaluated in the page, and a phone's webview process
  has a few hundred MB. Trouble starts around **100 000–200 000** entries with short ASCII names and around **50 000–100 000** with long
  non-ASCII ones.
- **Filen** is worse: an entry's encrypted metadata is a few hundred bytes of base64 (**estimate**: 400–600 B per file), so **a million files is a
  ~500 MB response**, parsed whole in Rust (and written to SQLite whole) before the first byte reaches the page. The Rust process is the first to
  feel it, and the listing takes as long as the download.

### What it looks like when it fails

The window stays on "Loading…" for a long time, then either the webview's tab crashes (the window goes blank or reloads and the last place is restored
— which lists the same folder again), or the backend is killed by the system on a phone. Nothing is corrupted: listing only reads. (There was
one *quadratic* cost besides — the Files tab asked for every entry's size with a call per entry, which took over four minutes for 100 000 entries; it is
fixed, see below.)

## What is already done

- The **Files tab** fetches sizes only for the entries of the page shown (Notes always did this for local folders): a 100 000-entry folder now shows in
  about 0.2 s (ASCII names; 2.5 s with 100-character Chinese names, the time being the directory scan and the message).
- Only the current page is rendered, and the page size is one global setting.

## Retrieving ids first, then metadata in chunks

It is the right shape for the **local file system and for the cache**, and not possible for Filen's network call:

- **Filen**: the API has no lighter listing — `/v3/dir/content` is the only call, and it returns the metadata with every entry. "Ids only" would
  save nothing on the wire, and the response can't be paged (there is no cursor). What can be bounded is what happens *after* the response
  arrives: parse it as a stream (serde's `StreamDeserializer`/a seq visitor) and write the cache rows in transactions of a few thousand entries, so the
  Rust side never holds the whole response as objects; then never send the whole folder up: the page asks **the cache database** for its
  window of rows — `SELECT … WHERE parent = ? ORDER BY is_dir DESC, name LIMIT ? OFFSET ?` (an index makes it cheap, a keyset cursor makes it constant) — and
  only the total count. The uuid ids are already stored (`remote_id`), so the id is a natural cursor.
- **Local folders**: the OS gives no ids, but the same shape works with what it has. One scan collects only `(name, is_directory)` in Rust (~60–150 B an
  entry, 1 M entries = 60–150 MB, no JSON and no webview copy) and keeps it, sorted, for as long as the folder is shown; the page asks for
  `(offset, limit)` and gets that many entries with their size and date (a `stat` per entry of the page only). A lighter variant without sorting in
  memory: list in the OS's order and page with an opaque cursor.

**Recommendation** (not built — it is a redesign of how listings travel, and nothing needs it below ~100 000 entries): one paged listing command per
source — `list_page(source, folder, offset, limit) → { entries, total }` — used by the Files tab, the Filen tab and Notes; the Rust side keeps the
scan or the cache rows. The frontend already thinks in pages and in "records skipped" (`lib/pagedPosition.ts`), so the client change is small:
`entries` stops being the whole folder and becomes the page (and `kbdFocus` an index into `total`). Until then the honest limit is the one above:
comfortable to ~100 000 entries, workable to a few hundred thousand on a desktop, and a phone should be expected to struggle sooner.
