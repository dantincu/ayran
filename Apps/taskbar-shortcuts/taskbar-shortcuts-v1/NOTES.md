# Release build

After making changes, rebuild and republish (the autostart shortcut points at `dist/TaskbarShortcuts.exe`, not the `bin/` output):

```
dotnet publish src/TaskbarShortcuts -c Release -r win-x64 --self-contained false -o dist
```

Restart the app afterwards (exit it from the tray icon, then relaunch `dist/TaskbarShortcuts.exe`) to pick up the new build.

Note: the output folder is named `dist`, not `publish`, because Bitdefender ended up
permanently blocking writes of an .exe file to the old `publish\TaskbarShortcuts.exe` path
after flagging it once (confirmed via direct file-level testing, not just a stale process
lock). If `dist` ever gets flagged too, just pick another folder name and republish there -
add both the project folder and the new exe to Bitdefender's Antivirus and Advanced Threat
Defense exceptions to reduce how often this happens.

# Autostart

Registered as a shortcut in the current user's Startup folder (no admin rights needed):

```
%AppData%\Microsoft\Windows\Start Menu\Programs\Startup\TaskbarShortcuts.lnk
  -> C:\A\T\ayran\Apps\taskbar-shortcuts\taskbar-shortcuts-v1\dist\TaskbarShortcuts.exe
```

This uses a Startup-folder shortcut rather than the `HKCU\...\Run` registry key because
Bitdefender's Advanced Threat Defense specifically blocks scripted writes to Run keys as a
persistence-technique heuristic (confirmed: it blocked a plain PowerShell `New-ItemProperty`
call even after adding an Antivirus + ATD exclusion for the app, since the exclusion covers
the app's file, not "a script modifying autorun registry keys" as a behavior). A shortcut
file in the Startup folder is a normal file write and isn't flagged the same way.

To remove autostart, delete the shortcut:

```
Remove-Item "$env:AppData\Microsoft\Windows\Start Menu\Programs\Startup\TaskbarShortcuts.lnk"
```

If you ever want to move back to the registry Run key instead, you can add it manually
through Windows' own Settings app (Settings > Apps > Startup) or via `regedit.exe` -
launching it that way from the Windows GUI hasn't triggered the same ATD block that a
scripted `New-ItemProperty` call does.
