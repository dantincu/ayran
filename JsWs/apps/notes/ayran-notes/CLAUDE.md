# Specs for Ayran Notes App

This should be cross platform app (for both mobile and desktop) that allows users to create and edit notes and child nodes using a hyerarchical view similar to that of folders and persist them as markdown files and folders either on the device's storage or on a cloud storage provided by the user. Please provide implementations for Google Drive, One Drive, Dropbox and Filen.IO. Ask for full drive permissions for all cloud storage providers but only ask for a root folder when the user chooses the local device file system as storage option.

## The format of notes storage

The notes should be persisted using the following conventions:

- There should be a root folder where this app has full read and write access that the user provides when they open the app for the first time (in case of cloud storage options, the root folder will be the root folder of the user's drive).
- Inside this root folder there should be a sub-folder with a relative path provided by the user using a popup window
  with an embedded file explorer view in it. This sub-folder will be the root folder where the actual note files and
  folders should live.
- Any note on any level of hierarchy should be able to have child notes and attached files and folders (themselves
  arranged in their own root folder sitting inside the note's folder besides folders of the note's child notes).
  The list of notes that sit at the root should look just like the list of child notes of a note.
- For every new note create 2 folders: one consisting of 3 digits (I will called this folder "the short name folder" and the 3 digits
  number "the note index"; start at 999, take the 3 digit indexes associated with existing notes, find the smallest existing note
  index, decrement it by 1 and that's the index for the new note) and the other folder's name ("the full name folder")
  starts with the same 3 digits of the newly computed note index, adds the `-` character and then the title of the note provided by the user (don't allow the title to contain leading or trailing white spaces; for the folder name replace invalid file name characters with the space, making sure there are no consecutive spaces in the resulting file name; if the user enters weird characers like tab or newline, show them an error and ask them to correct the title). The total length of this part of the second folder's name should not exceed 100 characters.
  The note title itself should not contain more than 1000 characters.
  The full name folder will contain 1 empty text file called `.keep`.
  The short name folder should contain the following files:
  - a json file named `[note].json` with the following format:

    ```json
    {
      "Title": "$profiles$",
      "CreatedAt": "2025-09-30T11:28:30.0731446Z",
      "InternalDirs": {
        "Internals": 1,
        "Files": 2
      }
    }
    ```

    Where `CreatedAt` is the UTC time stamp for the creation of the note (this app will always store time stamps in the UTC format and display them to the user using the local time) and `Title` contains the title provided by the user before having been encoded for file name or markdown or html. Let's ignore the `InternalDirs` property for now.

  - a json file named `[note-children].json` with the following format:

    ```json
    {
      "ChildNotes": {
        "999": {
          "Title": "Locuri de munca Bucuresti  Groups  LinkedIn",
          "CreatedAt": "2025-11-29T09:20:51.6800187Z"
        },
        "998": {
          "Title": ".NET Developer jobs in Romania  Groups  LinkedIn",
          "CreatedAt": "2026-02-04T07:39:27.4564757Z"
        }
      }
    }
    ```

    Where the `ChildNotes` property points to a map whose keys are note indexes of child notes of the current note and whose values are basically what sits inside the corresponding `[note].json` for each child note (which will sit in their own folder). Please note that you won't need to read the `[note].json` files for all child notes in order to update the `[note-children].json` file for the parent note when needed, as all the required information is already there in the `[note-children].json`.

  - A markdown file whose name consists of the following parts concatenated:
    - the `0-` string
    - the same string derived from the note's title that had been used for creating the full name folder
    - the `[note].md` string.

    This markdown file should hold the actual note content provided by the user. It should start with a markdown title like `# <note title>` where the title provided by the user when creating or renaming the note is being encoded propperly for markdown (and html). The note should also be renamed when the user edits this line directly (title of the note will be updated when the user taps on the save button). If the user deletes this title line, the last title before the edit should be kept as the note title (that will be stored in the json files and displayed to the user where needed). Whenever the title of the note is updated (either by the user editing the title line inside this file or by explicitly renaming the note through the app menu) the name of this file (and the following files) along with the name of the full name folder should be updated accordingly.

  - A `.html` file generated from the markdown file whenever the user taps on the save button. The name of this file should be the name of the markdown file (including its extension) followed by the `.html` extension.

  - A `.pdf` file generated from the html file whenever the user taps on the save button. The name of this file should be the name of the markdown file (including its extension) followed by the `.pdf` extension. NOTE: whenever the contents of the note only consists of the note title (like when a note has just been created, or when the user deletes all of the note's content except the title line) the html file should be deleted after the pdf file has been generated (or the html file may not be generated at all in such cases if its possible to generate pdf directly from html code). But always generate the html file if the contents of the note consists of anything more than just the markdown title.

- Folders of child notes should sit directly inside the short name folder of the parent note. Besides the folder pairs of child notes, a note short name folder can also contain pairs of folders whose short name start with `0` then are followed by a number that is incremented starting from 1 so as to not collide with existing folder names. The full folder name will, just like for note folder pairs, be obtained by concatenating the short folder name, the `-` character, and then one of the following:
  - `[note-files]` for a pair of folders whose short name folder would contain files and folders attached to the current note.
  - `[note-internals]` for a pair of folders whose short name folder would contain preferences set by the user through the app.

  Either of these 2 special kind of folder pairs will only be created when needed (like when the user adds files and folders to the note for the first time or when the user changes a note's label color or something like that).

- There will be 4 categories of notes (each with their own range of possible indexes):
  - Regular notes (indexes from 999 to 400)
  - Primary notes (indexes from 199 to 110)
  - Secondary notes (indexes from 299 to 200)
  - Ternary notes (indexes from 399 to 300)

  For each of these 4 categories of notes, the autodecrementing indexes should start at the specified number ending in 99 and, when the lower bound is reached (ending in 00 or 110 for primary notes) an error should be displayed to the user like "Cannot not create more than 600 regular notes in a single list" or "Cannot not create more than 90 primary notes in a single list" and so on.

  When the user deletes a note that is not the last one that was created in the current list of notes, a gap in the list of indexes will appear. So a button should be shown to the user somewhere in a menu that will trigger the "normalization of note indexes" of the current list of notes.

  The user should be able to add and remove stars for each note and add or remove a colored label for each note (for colored label, a color picker should be shown and, as an alternative, choose from recently used colors). Each note's star and/or label color should be stored both in the `[note].json` file for that note and in the `[note-children].json` file for the parent note. Also, the list of all the starred notes across the entire notebook should be kept in a json file inside a `[note-book]` special folder pair created at the root of the notebook (sibbling with the pairs of folders for the root notes) in similar ways that the `[note-files]` and `[note-internals]` special folder pairs sit inside note short name folders.

  The metadata for the notebook itself should be stored in a file called `[note-book].json` that sits at the root of the notebook, sibling with the `[note-book]` folders pair. The `[note-book].json` file should have the following format:

  ```json
  {
    "Title": "My Primary Note Book",
    "InternalDirs": {
      "Root": 1
    }
  }
  ```

- Let's get back at the `[note].json` file format. I already mentioned the `CreatedAt` and `Title` property. About the `InternalDirs` property, it contains a hash object that maps full folder names of special folder pairs with their indexes. An enum should be defined for the app like this:

  ```ts
  enum NoteInternalDir {
    Root = 1,
    Internals,
    Files,
  }
  ```

  The `Root` value is only used inside the `[note-book].json` file that sits at the root of the notebook. The `Internals` value is used for the folders pair where user preferences for the current note will be stored. The `Files` value is used for the folders pair where uploaded files and folders will sit.

Please store all the string and number constants I specified above in a json config file embedded in the app's executable or deployment files.

## Legal considerations

Please create the app so as to be ready to be deployed to PlayStore, AppStore, WindowsStore, and even the official app store on Ubuntu, and also downloadable as an executable for desktop and .apk for android (and similar for iOS if possible). So when the user opens the app for the first time, the app flow should contain all legally required steps that involve the user reading and accepting legal terms, privacy policies, personal data policies, (and GDPR where applicable). Please note that if the user wants to "delete all their personal data from this app" I won't be able to do this since all the data that this app creates and accesses sit on the user's cloud storage accounts (in folders visible by other apps that access that user's could storage) and/or their local device where they install this app, so there won't be any "personal data" that this app can delete.

## The notebook

Like previously stated, when the user first opens the app, they should choose how their notes should be stored (in a cloud storage of their choice or on their local device in a folder of their choice). This step should run for every notebook that the user creates or opens (an already existing notebook previously created by this app) or whenever the authentication tokens expire. This should happen in a modal window where after the user chooses the storage option, a file manager should be shown inside the same modal where the user chooses the root folder for the notebook. Upon choosing the note book root folder, the app should first check if there is a file called `[note-book].json`. If it exists, it should try to deserialize it and check that at least it contains the `Title` property and, if there already is a property called `InternalDirs`, its object value is valid and its keys are valid members of the `NoteInternalDir` enum. If this validation passes, the notebook should be opened. If no, an error message should be displayed to the user saying "this folder is not valid for as a notebook root folder". If there is no file called `[note-book].json`, a new one should be created after the user is asked for the title of the new notebook (which should also not contain more than 1000) characters and should not start or end with space and should not contain any other whitespace other than the space.

## App Structure

This app's main pages will be:

- Notes Explorer: the list of notes (either child notes of a parent note or the root notes for this notebook)
- File Explorer: the list of files and folder of a folder or the root folder. There will be 2 types of file explorers:
  - A "full file explorer" that allows the user to navigate the entire file hyerarchy of the root folder provided to the app
  - A "note files explorer" that allows the user to navigate only files and folders (along with subfolders) that are attached to a specific note (both the current note's path and the current folder's path relative to the note's `[note-files]` short name folder will be used in the page URI)

Note and file paths relative to the root of the notebook should be used everywhere across the app, except when the user chooses the actual notebook root place, where paths relative to the root folder is used instead. After the user chooses the notebook, even files that sit upper in hierarchy than the notebook root itself should have their paths specified relative to the notebook root, that is those paths will start with `../`. Another exception is for files and folders that are attached to a note, and there the path of the file should be relative to the short name folder where the note's files sit (it should only be used along with the path of the note relative to the root of the notebook).

In order to easily specify the full identifier of a file or folder or note, I want to use the `|` character (that is normally illegal in a file name) to separate the path of the note from the path of its attached files and folders:

- If a path has the format `||/<note-path>` it is a note path relative to the notebook root
- If a path has the format `||./<note-path>` it is a note path relative to the current note. A path like `||./../<note-path>` will be relative to the parent of the current note path. Paths like `//|../<note-path>` are invalid. The `||./` is the path to the current note.
- If a path has the format `|/<file-path>` it is a file path relative to the notebook root (the notebook itself doesn't have files attached to it, only notes do, so this is just a convention). So if you want to specify a path to a file called `my-file.md` that sits directly in the root folder of this app and the notebook root is at `/my-note-book/`, then a path to this file should be `|/../my-file.md`. In this case, a path like `|/../../my-file.md` will not be valid.
- If a path has the format `|./<file-path>` it is a file path relative to the current folder (either in the "full file explorer" or in the explorer that shows files attached to this note).
- If a path has the format `||/<note-path>/|/<file-path>` it is a file path relative to the note referenced by the `<note-path>` part of the path (actually the short name folder from the current note's folder that is the short name folder of a `[note-files]` pair). A path to a file attached to the current note would be like `||./|/<file-path>`. A path to a file attached to the parent note of this note would be like `||../|/<file-path>`. A path like `||/|/<file-path>` is a file path relative to the root of the notebook (points to the same file that `|/<file-path>` points to). A path like `||<note-path>/|./<file-path>` acts just like `||<note-path>/|/<file-path>`. A path like `||<note-path>/|../<file-path>` points to a file relative to the current note's short name folder (instead of the current note's attached files folder which `||/<note-path>/|/<file-path>` points to).

## App Session

All activity inside this app should be tied to something like a workspace, which I simply call "app session". The app session will have its own set of tabs that the user can open as new, delete and change the order of tabs in the list of tabs for this session. Inside the app there should be a page called "manage app session" where the user can create a new session the same way they created their first one, or open an existing session, after which the list of tabs will update accordingly. Along with app sessions and app tabs for each session, the id of the current tab for each session and the current session should also be stored. When creating a new session, the user will have the option to reuse the storage option already associated with an existing session (this way there will be multiple sessions for the same storage account or for the local device) while either opening a different notebook on the same root folder as the other session or use the same notebook that the other session uses but with a new set of tabs (start with 1).

Inside the "manage app session" there should be a way to edit the name of the current session (which by default syncs to the name of its associated notebook, which itself can be edited in the "manage notebook" page). So if the user leaves the "sync session name with notebook name" checked, the session name should not be editable. If it unchecks it, the session name becomes editable.

Every new session will start with 1 tab after opening its notebook and every session will be associated with exactly 1 notebook (but multiple sessions associated with the same notebook are allowed). Whenever the user clicks on a link, the uri of the current tab should change accordingly. All links (including button links and list rows that act like links) in the app should have the option for the user to press and hold the link and then a context menu must show up offering the user possibilities to open the link in the current tab, open it in a new tab (and go to the newly created tab) or open the link in a new tab while not leaving the current tab. The list of open tabs in the current session will be shown when a user clicks on an icon button somewhere in a toolbar. When the user chooses to open a new tab without leaving the current tab, this icon button should blink.

After the user chooses the notebook, the page it will be sent to is that that shows the list of the notes that sit at the root of the notebook with a special message like "create your first note" if there aren't any notes yet. This should be the same page where the children of a note are shown, only with an identifier containing the note path.

The state of all sessions should be persisted in json files in the device's app data folder, along with the identifier of the current session (and that session will open when the app is restarted). When the user changes the current session, the persisted identifier is updated accordingly.

## General UX considerations

The app's basic layout after the user chooses the storage option and notebook should contain an app header at the top optionally followed by a top toolbar (that will sit just below the app bar) and (when needed) an app footer. All these 3 horizontal bars will be visible immediately after the user chooses the notebook (and the page showing the root notes is shown with a special message like "create your first note" if there aren't any notes yet). The app header and top toolbar should fade out and the footer should fade in when the user scrolls down (or swipes up). The app header and top toolbar should fade in and the footer should fade out when the user scrolls up (or swipes down). Initially, all 3 can be visible if needed (if there's content in them).

The app header should contain either the page title or the current resource's icon (like a folder, file - and different icons depending on file type) or note etc. This should also be the name of the current tab (the app header will act like a tab head, only I want it to take the full width of the screen, so there will never be multiple tab heads at the same time like in a regular tab manager). At the right edge of the app header there should be a close button that closes the current tab and navigates to the next tab in the list. This button should only be shown if there is more than 1 tab open in the current session.

The top toolbar should contain the following icon buttons:

- A back button that usually will do the same thing the mobile (or desktop browser) back button does, but exceptions should be allowed.
- A "go to parent" button that should be visible when navigating lists inside hyerarchical data structures, like list of files and folders or list of child notes of a parent note or list of root notes.
- When editing a document (like a note or a text file) there should be a save button, an edit or preview button (when editing notes or markdown or html files).
- A button to show the list of tabs for the current session. Should only be visible if there is more than 1 tab in the current session.
- An options button that would show a context menu when pressed. This context menu should contain the following items:
  - A row of icon buttons containing the following link buttons:
    - A home page link icon button
    - A settings link icon button (will lead the user to the settings page)
    - A "Manage App Session" link icon button (will lead the user to the "manage app session" page)
    - A "Manage Notebook" link icon button (will lead the user to the "manage app notebook" page)
  - When appropriate, it should also contain menu entries for creating files or folders (or notes when inside pages that show a list of notes), for reordering notes, for normalizing note indexes, and for moving files, folders or notes.

Regarding the browsing of files and folders and notes, I would like to let the user enable a "docking layout" where multiple tabs can be shown side by side horizontally (just like in VS Code) like when showing the preview of a markdown file or a note. And when showing the preview or a mardkdown or a html file or a note, the preview should update as the user types or modifies the source code. When there is such a split view with panels sitting side by side, the panels should be resizable.

### App modals and popovers

I want to be able to open a modal from inside another modal (with infinite depth). This should create a logical stack of modals inside the app. The current modal should be destroyed before opening another one from it but the way to reconstruct it identically should be stored somewhere in the app's state, so that when the user closes the last opened modal, the previously opened pops back up. And when I mean "the user closes" I mean that modals too should have a header with a title, to the left of the title sitting a back button that closes the current modal and pops back in the previous modal (if there is no previous modal, there shouldn't be a back button here). Pressing the escape key should have the same effect as closing just the current popup. On the right side of the title should be a close button that closes the entire stack of modals (there should be an option for modals depending on which they can be manually closed or only programatically - might be usefull in the future). To the left of the close-all-modals button there should be a minimize buton (that will also be shown conditionally and not by default - one such place is the popups where the user browses for a file or folder or note path to be referenced somewhere like when moving or copying a file, folder or note). The minimize button will visually have the same effect as closing all the modals. But, while closing all modals will also remove the stack of modals from the app state, minimizing the stack of modals doesn't remove them from the app state (I again refer to the way for the stack to be reconstructed, while the actual components should indeed be destroyed). Then a button should sit on the top toolbar for each tab that has such stacks of modals minimized (yes, there can be more than 1 stack of minimized modals for the same tab). Upon clicking that button, the user sees a popover showing a list of currently minimized stacks of modals for the current tab. For each stack only the title for the last opened modal should be visible and written with bold font. And each row in this list of stacks should be expandable where a vertical list of modals in the stack should be shown. Finally, for each such row (whether expanded or not) there should be a button for restoring that stack of modals (which visually will have the effect of restoring the last modal only). Also, in the list of current tabs, a similar icon should be placed in front of each tab that has stacks of modals minimized. Regarding the list of tabs for the current session, the current and previous tabs should be highlighted someway and 2 buttons on the header of that modal should bring the current or previous tab into view.

## Rendering html content

When rendering html content, I guess a web view component should be used. No user-provided javascript should be executed inside the preview, so any script tags should be ignored. Also, the html shouldn't be able to fetch resources from the network (anything that has attributes like src should not work as such, I'll talk about this later).

The html will either be loaded as such from a html file or (when previewing markdown files or notes) generated from markdown. In either cases, the user should never be able to navigate when clicking on links, but the link should be shown inside the app footer as an actual link (and dissappear when the link goes out of focus inside the preview) and the user should then be able to navigate to the url of this link from the footer with the previously mentioned 3 options:

- navigate in the current tab
- open a new tab and leave the current tab
- open a new tab without leaving the current tab

The default behavior should be to open the link in current tab if the link points to this app. If it's an external link, open it in the device's default browser.

Regarding url's encountered inside the preview: I want to be able to generate url's solely from the item path using the `|` character like I previously mentioned. So taking into account those convensions stated above, the app should parse all the html content and, beside ignoring javascript tags, it should take all anchors and `img` tags that it encounters and if the url from the src attribute starts with `|` or `||` it should be replaced with the URI to the appropriate resource. If the url is a relative file path (doesn't start with `|` or `||` but is still a file path, so no absolute URI's and no query string or URI hashes) the resource relative to the current resource should become the target of the link. The url of `img` elements should be replaced with a url to an embedded resource containing the actual image bytes.

Other imported resources like external fonts and tags like `<object>` should be ignored. But let's allow the user to add `<style>` tags inside html and markdown files. And parse the style tags and when `@import` statements are encountered, fetch the css files that the import statements point to and add their contents as further `<style>` tags. The urls of the import statements inside `<style>` tags should be modified using the same rules regarding the `|` character I mentioned above (so use a css parsing method that doesn't crash when seeing the pipe symbol inside the url of an import statement).

Both html and markdown files can contain full html documents, like the root tags to be `<html>` but the content outside `<body>` should be ignored.

## User settings & preferences

User settings & preferences should be stored inside the `[note-book]` folders pair (that sits at the root of the notebook).

An example of such a setting would be the dark mode which the user can toggle on or off (and whose default value is that of the system). This option, along with the rest of settings and preferences should be saved on a per note book basis. So when toggling on the dark mode on a session and then creating a new session with a different notebook that doesn't have the dark mode specified, the system default should again be applied.

Another example of user preference would be the stylesheet to be applied to the markdown/html preview pages. The default stylesheet should sit inside the source code of this app, but the user should be able to override it. Btw, the dark mode setting should also apply to the generated preview html by adding a `.dark` or `.light` css class on the `html` tag (unless the source html itself provided by the user contains one of these classes explicitly on the html tag).

And a third example of user preference would be the app's shortcuts (yes, the user should be able to edit the app's shortcuts like that for navigating the file and explorers and closing modals and popovers). This preference again should also be saved on for notebook basis.
