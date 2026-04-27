# Ayran Mobile Battery Logger Android App

I want an app for android that logs the current battery level to a file filen.io;
So the UI of the app will have a screen where the path (and id) of the file in filen.io where the logs are to be written will be shown.
Next to the path there should be a button which triggers a popup window that browses the authenticated user's filen.io drive and lets them choose an existing text file (ideally with extension json). Below the path there should be an editable numeric textbox representing the number of log entries that should be kept in the log file (the default should be 10). The value for these 2 options should be stored in a json file somewhere in the app data folder (and should be deleted when the user chooses to delete all data for this app in android settings page). Then there should be a button that triggers the operation of reading the current battery level and logging it to the user's chosen file on filen.io drive. This operation should also be triggerable by tasker without the UI of the app popping up, so periodic logging happens in the background when using tasker (please help me setup tasker with this app after I deploy it to my devices).
Of course, this app screen should only be visible after the user has authenticated successfully. Before the user authenticates, the login window should be shown instead. I also want to use a filen.io api key for this app (please help me set that up too).
Finally, each battery log entry should contain the battery level and the date time (up to seconds) when the level was read. And all logs should be written in json format (like an array that is the value of a property like "logs", each element of the array representing one log entry). Any new entry should be inserted on the first position and if the length of the array exceeds the option chosen by the user, last added entries should be discarded accordingly. So this log file should look something like this:

```json
{
  "logs": [
    {
      "dateRead": "2026-04-27 09:50:21",
      "batteryLevelPercent": 81
    },
    {
      "dateRead": "2026-04-27 09:45:21",
      "batteryLevelPercent": 83
    },
    {
      "dateRead": "2026-04-27 09:40:21",
      "batteryLevelPercent": 84
    }
    // and so on...
  ]
}
```
