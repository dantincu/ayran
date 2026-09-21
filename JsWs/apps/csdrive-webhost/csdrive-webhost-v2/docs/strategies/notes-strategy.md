# Notes Strategy

A note item is persisted through a pair of folders whose names are created as defined in [./folder-pairs-strategy.md](./folder-pairs-strategy.md). Inside the short folder name will live child notes of this note item, along with the following files and folders relevant for this note item:
- A markdown file containing the actual note contents. When first creating a note, this markdown file will be created from the start and will contain the note title as a markdown title (primary heading). The title will be obtained from the user directly (either from command line or from the UI of an app) and then markdown/html encoded in order to be inserted as a markdown title.
- A file called `[note].json` whose content will have the format:
  ```
  {
    "Title": "Decizie de gratuitate 2026-09-11",
    "CreatedAt": "2026-09-19T07:34:04.0283216Z",
    "UpdatedAt": "2026-09-20T07:34:04.0283216Z
  }
  ```
- A file called `[note-children].json` whose content will have the format:
  ```
  {
    "ChildNotes": {
      "999": {
        "Title": "Decizie de gratuitate 2026-09-11",
        "CreatedAt": "2026-09-19T07:34:04.0283216Z"
      },
      "998": {
        "Title": "second note",
        "CreatedAt": "2026-09-19T07:34:04.0283216Z",
        "UpdatedAt": "2026-09-20T07:34:04.0283216Z
      }
    }
  }
  ```
- (optionally) pairs of folders containing either note files (user-uploaded files and folders) or note internals (reserved for future use - who knows).

How the full folder name part and markdown file names are computed:
- the full folder name part is basically the user-provided title from which we simply discard characters that are not allowed in a file name (except for the forward slash, which we will replace with the % character, and the % itself will be replaced with %%). The resulting string will need to have no more than 100 characters. If then the 100th character is the first % from a %% sequence escaping an original %, then that 100th character will also be discarded.
- the markdown file name is a concatenation of:
  - a prefix: the string "0-"
  - the full folder name part
  - a suffix: the string "[note]"
  - the markdown extension: ".md"

When should the markdown file name and full name folder be updated:
- when the user updates the note title from command line or app UI directly - then also update the markdown primary heading from the markdown file and the information in the `[note].json` file
- when the user edits the markdown file and changes the markdown primary heading and then saves that file and the app detects the change (or the user themselves calls a command line utility to update the names of files and folders). Here too the new title will be saved in the `[note].json` file.

## About updating the note indexes

Normally, folder pair index gaps will not be filled, so normalizing the note indexes will be a standard operation that can be performed either on demand by the user or automatically by an Notes app when moving/deleting notes from the child notes of a parent note. Normalizing the indexes should only affect the pairs of folders that will end up having new indexes. To make things easy here, the alternative folder name prefix should be used when swapping indexes. Basically all the affected pairs will have their names applied that prefix instead of the main prefix, then their indexes changed and the main prefix reapplied in 1 single operation (1 operation per pair of folders).

## The root folder of a notebook

Since we only mentioned that a note can have nested child notes, there will also be a root folder containing top level notes and note sections. That folder will be the notebook root folder. It will contain file called `[note-book].json` with the following format:

```
{
  "Title": "My Primary Note Book",
  "CreatedAt": "2026-09-19T07:34:04.0283216Z",
  "NoteBookGuid": <some-guid>
}
```

And it will also contain the notebook pair of folders (again reserved for future use).

### How to user opens or creates a notebook

Just like a .NET solution is identified by a single file with the ".sln" extension, an Ayran Notebook will be identified by a file whose name is either equal to or ends with `[note-book].json` (and of course has a valid structure that matches the one I described above). Then the folder containing this file will be the root folder of the notebook.

## How the Notes app implements notebooks

*(Written as it was built; the code is `src/system/notes/notebooks.ts`, `notebookFile.ts`, `NotebooksPage.tsx`, `LocationPicker.tsx`.)*

**Home.** A Notes tab that names no place opens a **home page** with two links: *Manage notebooks* and *File manager* (the file manager the app always had).

**Listed and found.** The app keeps **a list of the notebooks it knows** (in its own state, `notes.notebooks`): for each, the notebook's GUID, its title as last seen, where it is (a folder of this device, or a Filen account — never a branch, a notebook lives in the account), the folder and the file name. The list is the app's; the notebook is wherever its file is. A notebook is **listed** when it is in that list and **found** when its file exists somewhere and the app hasn't been told — the two are told apart by the `NoteBookGuid`. So *adding an existing notebook* means pointing at its file: the picker shows every notebook file it meets with its title and whether it is **in your list** or **not in your list yet**; a file that is not a valid notebook (not JSON, no title, no date, no GUID) is refused with the reason; a notebook whose GUID is listed already is reported as such, with where it is listed.

**The file is the truth.** Opening the *Manage notebooks* page checks each listed notebook's file: can the place be reached (a Filen account that is not connected, a folder that was forgotten, a file that is gone or no longer a notebook is shown with the reason), and what is its title now — a title changed outside the app replaces the one in the list. Changing a title in the app writes the file first (every other key in it kept) and then the list, so a failure leaves both as they were. *Taking a notebook out of the list* deletes nothing.

**Creating.** The person gives a title and then chooses the notebook's root folder in the picker (any folder of this device or of a Filen account; folders can be made there). Ideally the folder is empty, but that is **not required**. The file written is `[note-book].json` — `Title`, `CreatedAt` (UTC, seven fractional digits like the example above; JavaScript only has milliseconds, so the last four are zeros) and a new `NoteBookGuid`, indented, ending with a line break. **If the folder already has a notebook** — any file whose name is or ends with `[note-book].json`, in any case — the person is warned, both in the picker and in a dialog listing those files with their titles, because a notebook's notes live in its root folder and a second notebook there would share them; they can choose another folder, cancel, or create it anyway. In that case (and whenever `[note-book].json` itself is taken) the new file is named after its title, `<title> [note-book].json` — the title made into a name the way this strategy says for note folders (`namePartFromTitle`) — and nothing is ever overwritten.

## How the Notes app implements notes

*(The code is `src/system/notes/noteModel.ts` and the note pages; `CLAUDE.md`, "Notes", has the details.)*

**Writing.** A new note is written in this order, so a failure leaves nothing half-listed: its short folder, its marker folder (holding a `.keep` with a dash, so it is never empty), then inside the short folder `[note].json` (`Title`, `CreatedAt`, `UpdatedAt`), the markdown (`0-<name part>[note].md`, whose first line is the title as a heading, html-encoded and with markdown's marks escaped) and `[note-children].json`, and last its entry in its parent's `[note-children].json`. The notebook's root has a `[note-children].json` of its own for its top level notes. The index is one more than the highest used by a short folder *or* a marker (gaps stay: "after the largest"); the two-digit pairs (`01`, the note's files) never take a note's number.

**Reading.** The children of a note or notebook are read from `[note-children].json`. **When that file is missing or damaged, the list is rebuilt from the `[note].json` files of the child notes**: every short folder (`NNN`, three digits) of the parent is a candidate, and its own `[note].json` gives the child's `Title`, `CreatedAt` and `UpdatedAt` — a folder without a readable `[note].json` isn't a note and is left out. The rebuilt list is what the app shows at once, and it is written to `[note-children].json` with the next change of that list (adding, renaming, deleting a child), so the children that were there are kept.

**Renaming** is done when the title is changed in the app *and* when the markdown's first heading is edited and saved: the marker folder, the markdown file, the heading, `[note].json` and the parent's list are all made to match.

**A note's address** is the path of its short folder with the query key `note`: `/Book/001/002?note`. **A note's files** live in the two-digit pair `01` (with `01-Note files`) inside its short folder.

**Not built yet:** note sections, the notebook's reserved pair of folders (`03-[note-book]`), moving notes between parents, and opening a note from a link inside a web page (a note's address is opened from *Go to a path*).
