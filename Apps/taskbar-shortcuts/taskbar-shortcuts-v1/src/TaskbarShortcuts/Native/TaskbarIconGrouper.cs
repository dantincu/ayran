using System.Diagnostics;
using System.Text.RegularExpressions;
using System.Windows.Automation;

namespace TaskbarShortcuts.Native;

/// <summary>
/// Groups real windows by taskbar icon and orders the groups to match the real taskbar's
/// left-to-right layout, read via UI Automation. Also emits a group for every pinned icon
/// that has no open window, carrying a Launch action that clicks the real taskbar button.
/// The taskbar's internal structure is undocumented and has changed across Windows 11
/// releases, so any failure here falls back to one ungrouped, unordered group per window
/// rather than throwing.
///
/// Taskbar buttons don't expose the underlying window handle(s) or title via UI Automation -
/// their Name is the app's display name plus a "- N running windows pinned" suffix (e.g.
/// "Google Chrome - 2 running windows pinned"). So windows are matched to buttons by app
/// identity (the process exe's FileDescription, which is usually - but not always - the
/// same string the shell uses as the app's display name) rather than by window title.
/// </summary>
internal static class TaskbarIconGrouper
{
    private const string TaskbarButtonClassName = "Taskbar.TaskListButtonAutomationPeer";

    private static readonly Regex RunningWindowsSuffix =
        new(@"\s*-\s*\d+\s+running\s+windows?\s+pinned\s*$", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex PinnedSuffix =
        new(@"\s+pinned\s*$", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    // Cases where the exe's FileDescription doesn't match the shell's display name for the app.
    private static readonly Dictionary<string, string> ProcessNameAliases =
        new(StringComparer.OrdinalIgnoreCase)
        {
            ["explorer"] = "File Explorer",
        };

    public static List<TaskbarIconGroup> BuildGroups(List<TaskbarWindowInfo> windows)
    {
        try
        {
            var buttons = GetTaskbarButtons();
            if (buttons.Count == 0) return FallbackGroups(windows);

            var windowsByButton = new List<TaskbarWindowInfo>[buttons.Count];
            for (var i = 0; i < buttons.Count; i++) windowsByButton[i] = [];

            var unmatched = new List<TaskbarWindowInfo>();
            foreach (var window in windows)
            {
                var appName = GetAppDisplayName(window.Handle);
                var rank = appName is null ? -1 : FindButtonRank(appName, buttons);
                if (rank >= 0)
                {
                    windowsByButton[rank].Add(window);
                }
                else
                {
                    unmatched.Add(window);
                }
            }

            var groups = new List<TaskbarIconGroup>();
            var number = 1;

            for (var i = 0; i < buttons.Count; i++)
            {
                var groupWindows = windowsByButton[i];
                var button = buttons[i];

                groups.Add(new TaskbarIconGroup
                {
                    Number = number++,
                    DisplayName = button.Name,
                    Windows = groupWindows,
                    Icon = groupWindows.Count > 0
                        ? groupWindows[0].Icon
                        : ButtonIconCapture.CaptureIcon(button.BoundsX, button.BoundsY, button.BoundsWidth, button.BoundsHeight),
                    Launch = groupWindows.Count == 0
                        ? () => TaskbarButtonLauncher.ClickAt(button.CenterX, button.CenterY)
                        : null,
                });
            }

            foreach (var w in unmatched)
            {
                groups.Add(new TaskbarIconGroup
                {
                    Number = number++,
                    DisplayName = w.Title,
                    Windows = [w],
                    Icon = w.Icon,
                });
            }

            return groups;
        }
        catch
        {
            return FallbackGroups(windows);
        }
    }

    private static List<TaskbarIconGroup> FallbackGroups(List<TaskbarWindowInfo> windows)
    {
        var number = 1;
        return windows.Select(w => new TaskbarIconGroup
        {
            Number = number++,
            DisplayName = w.Title,
            Windows = [w],
            Icon = w.Icon,
        }).ToList();
    }

    private static int FindButtonRank(string appName, List<TaskbarButtonInfo> buttons)
    {
        for (var i = 0; i < buttons.Count; i++)
        {
            if (Normalize(buttons[i].Name) == Normalize(appName)) return i;
        }

        for (var i = 0; i < buttons.Count; i++)
        {
            var button = buttons[i].Name;
            if (button.Contains(appName, StringComparison.OrdinalIgnoreCase)
                || appName.Contains(button, StringComparison.OrdinalIgnoreCase))
            {
                return i;
            }
        }

        for (var i = 0; i < buttons.Count; i++)
        {
            if (HasSignificantWordOverlap(appName, buttons[i].Name)) return i;
        }

        return -1;
    }

    private static bool HasSignificantWordOverlap(string appName, string button)
    {
        var words = appName.Split([' ', '-', '_'], StringSplitOptions.RemoveEmptyEntries)
            .Where(w => w.Length >= 3);
        return words.Any(w => button.Contains(w, StringComparison.OrdinalIgnoreCase));
    }

    private static string Normalize(string value)
        => new(value.Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());

    private static string? GetAppDisplayName(nint hWnd)
    {
        try
        {
            NativeMethods.GetWindowThreadProcessId(hWnd, out var processId);
            using var process = Process.GetProcessById((int)processId);

            if (ProcessNameAliases.TryGetValue(process.ProcessName, out var alias)) return alias;

            var description = process.MainModule?.FileVersionInfo.FileDescription;
            return string.IsNullOrWhiteSpace(description) ? process.ProcessName : description;
        }
        catch
        {
            return null;
        }
    }

    private readonly record struct TaskbarButtonInfo(
        string Name, double Left, int CenterX, int CenterY, int BoundsX, int BoundsY, int BoundsWidth, int BoundsHeight);

    private static List<TaskbarButtonInfo> GetTaskbarButtons()
    {
        var tray = AutomationElement.RootElement.FindFirst(
            TreeScope.Children, new PropertyCondition(AutomationElement.ClassNameProperty, "Shell_TrayWnd"));
        if (tray is null) return [];

        var buttons = tray.FindAll(
            TreeScope.Descendants, new PropertyCondition(AutomationElement.ClassNameProperty, TaskbarButtonClassName));

        var entries = new List<TaskbarButtonInfo>();
        foreach (AutomationElement button in buttons)
        {
            var name = button.Current.Name;
            if (string.IsNullOrEmpty(name)) continue;

            var stripped = RunningWindowsSuffix.Replace(name, string.Empty);
            stripped = PinnedSuffix.Replace(stripped, string.Empty).Trim();
            if (stripped.Length == 0) continue;

            var rect = button.Current.BoundingRectangle;
            entries.Add(new TaskbarButtonInfo(
                stripped,
                rect.Left,
                (int)(rect.Left + rect.Width / 2),
                (int)(rect.Top + rect.Height / 2),
                (int)rect.Left,
                (int)rect.Top,
                (int)rect.Width,
                (int)rect.Height));
        }

        return entries.OrderBy(e => e.Left).ToList();
    }
}
