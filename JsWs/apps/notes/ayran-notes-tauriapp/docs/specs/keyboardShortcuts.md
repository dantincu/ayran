# Keyboard shotcuts

Let's add keyboard shortcuts for our app (for our entire app). I want our shortcuts to be configurable, so let's put them in a json file that is read when from rust backend our app starts. The structure of the json file should be as follows:

```json
{
  "shortcuts": {
    "closeModal": {
      "name": "Close modal",
      "keys": "Esc"
    },
    "closeAllModals": {
      "name": "Close all modals",
      "keys": "Shift+Esc"
    },
    "maximizeModal": {
      "name": "Maximize modal or bring it back to regular size",
      "keys": "Ctrl+M X"
    },
    "minimizeAllModals": {
      "name": "Minimize all modals",
      "keys": "Ctrl+M N"
    },
    "showCurrentlyOpenedTabsModal": {
      "name": "Show currently opened tabs modal",
      "keys": "Ctrl+T L"
    },
    "openNewTab": {
      "name": "Open new tab",
      "keys": "Ctrl+T T"
    },
    "goToNextTabFromHistory": {
      "name": "Go to next tab from history",
      "keys": "Ctrl+T Shift+=" // Here I want `Shift+=` to mean press shift and the equals symbol at the same time - that would yield the actual `+` symbol when typed
    },
    "goToPrevTabFromHistory": {
      "name": "Go to prev tab from history",
      "keys": "Ctrl+T -" // Here I want the `-` to be interpreted as such: after pressing Ctrl+T, simply press the dash key and the keyboard should be activated
    },
    "goToNextTab": {
      "name": "Go to next tab",
      "keys": "Ctrl+T N"
    },
    "goToPrevTab": {
      "name": "Go to prev tab",
      "keys": "Ctrl+T P"
    }
  },
  "scopes": {
    "global": {
      "shortcuts": [
        "closeModal",
        "closeAllModals",
        "maximizeModal",
        "minimizeAllModals"
      ]
    },
    "mainApp": {},
    "notebookModule": {
      "shortcuts": [
        "showCurrentlyOpenedTabsModal",
        "openNewTab",
        "goToNextTabFromHistory",
        "goToPrevTabFromHistory",
        "goToNextTab",
        "goToPrevTab"
      ]
    }
  }
}
```

Note that I've defined the concept of scopes for shortcuts. That means that every place (page or modal or popover opened, for example) in our entire app will have an array of scopes assigned to it (the "global" scope will be assigned to any possible place in our app, so it will always be on the first position of that array). And a global keydown handler should be attached whenever a new window (or the main app) starts with `document.addEventListener("keydown", (e) => {...}` where for every single keystroke we check whether current key combination hits (either fully or partially) any shortcut that is part of the "shortcuts" array of any of the scopes present in the array of current scopes. If the key combination fully matches a shortcut, that shortcut's handler should execute. Otherwise, if the combination only partially matches such a shortcuts, those shortcuts should be put inside a list of "partially matching shortcuts" and for each element in this array have an counter for the index of the key from the shortcut this combination has just matched. Then on the next keydown event, it should again look if the current combination matches a single-combination shortcut, or if it partially matches any of the elements in our array I've mentioned above (for each such element that keeps matching that counter should be increased) or if it matches the first combination for any of the registered shortcuts that are currently in scope. So at any point if a shortcut matches fully it should be executed and the list of partially matching shortcuts should be cleared. If a partial or full match happens, the `e.preventDefault()` should be called to prevent the user from typing these shortcut symbols to a textbox if one is currently focused. NOTE: I've already seen that pressing the ENTER key when a textbox is focused triggers the submit action which is great and this should not be registered in our system (and the ENTER key alone with no modifiers should not be allowed as a custom shortcut combination). Finally, add a link from the main app's settings page to a page where the user can overwrite the default shortcuts our app provides. When they click on save, the json file from our app data folder should be overwritten. And there should be an option to let the user sync this json file on the cloud. So from this page let them chose a json file path (either to an existing file or to a new one) where these shortcuts should be synced. When first confirming this path, the contents of that json file should be loaded and parsed and the custom shortcuts in our app should be overriden. Then when they modifty something and click save, the local json file should first be written and (if there's a sync option) the file from the cloud should get written again. (Note: when serializing this json file only include the overriden shortcuts and for each only include the "keys" array, not the name, also do not include the "scopes" object). So finally, let's save the contents I've just described above into a config file in our source code named "defaultKeyboardShortcuts.json" and when the user decides for the first time to override any of the shortcuts, only then write the overriden shortcuts to "keyboardShortcuts.json" to our app data folder and then show the option to sync to the cloud.
