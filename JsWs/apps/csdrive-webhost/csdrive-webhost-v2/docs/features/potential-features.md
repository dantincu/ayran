# Features

This file will contain various potential features that comes to my mind and are too significant in order to put them in todo files. Once implemented a feature, the coding assistant should move it from New Features to Implemented Features.

## New Features

1. Let's add a dev tools module in our admin app (user has to go to settings and at the bottom of that page should be an expandable section called Advanced under which will be a checkbox for enabling the dev tools. Then a new tab page will be visible just before the about+help, which will be at the last position). For starters, this dev tools module, will contain a page called Logs which will show operations performed by our app (like every request made to the filen api) with log levels, log names, time stamps + filtering and sorting functionality. I will use this especially on Android to give the coding assistant as much info as I can when bugs appear. By default this logger page will not persist its logs, so it will start fresh on every app start. Let's still give the option to persist the logs in an sqlite db file (and maybe autoarchive logs in this case - create a new sqlite db file and rename the one being archived). What logs should be written at the moment will be these:
- all errors (at least the critical ones) and warnings
- information logs for admin-only operations + adding/removing notebooks.
- debug logs for all filen requests
- trace logs for even more detailed stuff, like before and after a request to filen, all requests to local file system, adding/removing tags where we have them and changing settings and options.

   By default only logs from the current sqlite db file will be shown. So there should be a separate filter for picking the sqlite db file to browse. The sqlite db should be archived based on total size of logs in it or simply once a month or so? I would take a combined approach, so have a max value for the total size of logs after which we archive it before 1 month has passed.

   Important: never put sensitive information in the logs. So no file contents, but I think file names and relative file paths (or even cloud storage item ids) could be added to the logs. Likewise, if we ever log search queries made by the the user, don't include text parts of the searches.

   Encrypting logs: is that possible?

   Simple (and preferred) alternative to all this logging module: file logs (and tell me where I can find those logs both on Android and on Windows).

## Implemented Features