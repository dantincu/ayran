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