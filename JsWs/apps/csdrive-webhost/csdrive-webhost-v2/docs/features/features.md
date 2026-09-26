# Features

This file will contain various features that comes to my mind and are too significant in order to put them in todo files. Once implemented a feature, the coding assistant should move it from New Features to Implemented Features.

## New Features

1. Let's complete our system of keyboard shortcuts: everywhere on our pages (the admin app and the Notes app) we should be able to reach the page's top row of icon buttons using the Alt+Shift+J key combination (that will focus the first button in the row of buttons). Likewise, when a row/item in a list is focused (having got there through arrow keys or pgup or pgdown etc) we should be able to focus its row of action buton (first button focused) using the Alt+J key combination. Then moving inside a row of action buttons is done using the left and right keyboard arrows and home and end. Pressing ENTER while focused on a button will trigger that button's action.

   For faster navigation let's add the following shortcuts for all lists in our app, including the list of icon in a row of icons once its focused (including a page's top row of buttons and a list item's row of action buttons):
   - Alt+N will move 2 items forward, while Alt+P will move 2 items backward
   - Alt+. will move 5 items forward, while Alt+, will move 5 items backward
   - PgDown will move 10 items forward, while PgUp will move 10 items backward
   - Alt+] will move 20 items forward, while Alt+[ will move 20 items backward
   - Alt+' will move 50 items forward, while Alt+; will move 50 items backward

2. Let's add a dev tools module in our admin app (user has to go to settings and at the bottom of that page should be an expandable section called Advanced under which will be a checkbox for enabling the dev tools. Then a new tab page will be visible just before the about+help, which will be at the last position). For starters, this dev tools module, will contain a page called Logs where the user will have the option to change the log level for our app (yes, we should also implement file logging and tell me where I can find those logs both on Android and on Windows). This logging functionality should be done solely in rust, so the frontend shouldn't even be aware of it.

   Logs that should be written at the moment will be these:
   - all errors (at least the critical ones) and warnings
   - information logs for admin-only operations + adding/removing notebooks.
   - debug logs for all filen requests
   - trace logs for even more detailed stuff, like before and after a request to filen, all requests to local file system, adding/removing tags where we have them and changing settings and options.
   
   Important: never put sensitive information in the logs. So no file contents, but I think file names and relative file paths (or even cloud storage item ids) could be added to the logs. Likewise, if we ever log search queries made by the the user, don't include text parts of the searches.

3. Let's add an option to convert a pdf to a html file and then to convert the html to plain markdown (markdown without html tags, only <u></u> being allowed). For both conversions, add an option to exact each page in a separate html file (and then mass convert from html to markdown). Also, let's add an option to view a pdf file in our app.

## Implemented Features