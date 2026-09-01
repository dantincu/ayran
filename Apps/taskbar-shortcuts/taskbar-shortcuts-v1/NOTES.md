# Release build

After making changes, rebuild and republish (the autostart entry points at `publish/TaskbarShortcuts.exe`, not the `bin/` output):

```
dotnet publish src/TaskbarShortcuts -c Release -r win-x64 --self-contained false -o publish
```

Restart the app afterwards (exit it from the tray icon, then relaunch `publish/TaskbarShortcuts.exe`) to pick up the new build.

# Autostart

Registered via a per-user registry value, no admin rights needed:

```
HKCU\Software\Microsoft\Windows\CurrentVersion\Run
  TaskbarShortcuts = "C:\A\T\ayran\Apps\taskbar-shortcuts\taskbar-shortcuts-v1\publish\TaskbarShortcuts.exe"
```

To remove autostart:

```
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "TaskbarShortcuts"
```
