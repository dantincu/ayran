using System.Diagnostics;
using System.Text.RegularExpressions;
using System.Windows.Automation;

namespace TaskbarShortcuts.Native;

/// <summary>
/// Best-effort ordering of windows to match their left-to-right position in the real
/// taskbar, read via UI Automation. The taskbar's internal structure is undocumented and
/// has changed across Windows 11 releases, so any failure here just falls back to the
/// caller's original order rather than throwing.
///
/// Taskbar buttons don't expose the underlying window handle or title - their UIA Name is
/// the app's display name plus a "- N running windows pinned" suffix (e.g. "Google Chrome
/// - 2 running windows pinned"). So windows are matched to buttons by app identity (the
/// process exe's FileDescription, which is usually - but not always - the same string the
/// shell uses as the app's display name) rather than by window title.
/// </summary>
internal static class TaskbarOrderProvider
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

    public static List<TaskbarWindowInfo> OrderByTaskbarPosition(List<TaskbarWindowInfo> windows)
    {
        try
        {
            var buttons = GetTaskbarButtonsLeftToRight();
            if (buttons.Count == 0) return windows;

            return windows
                .Select(w => (Window: w, Rank: FindButtonRank(GetAppDisplayName(w.Handle), buttons)))
                .OrderBy(x => x.Rank)
                .Select(x => x.Window)
                .ToList();
        }
        catch
        {
            return windows;
        }
    }

    private static int FindButtonRank(string? appName, List<string> buttonsLeftToRight)
    {
        if (string.IsNullOrEmpty(appName)) return int.MaxValue;

        for (var i = 0; i < buttonsLeftToRight.Count; i++)
        {
            if (Normalize(buttonsLeftToRight[i]) == Normalize(appName)) return i;
        }

        for (var i = 0; i < buttonsLeftToRight.Count; i++)
        {
            var button = buttonsLeftToRight[i];
            if (button.Contains(appName, StringComparison.OrdinalIgnoreCase)
                || appName.Contains(button, StringComparison.OrdinalIgnoreCase))
            {
                return i;
            }
        }

        for (var i = 0; i < buttonsLeftToRight.Count; i++)
        {
            if (HasSignificantWordOverlap(appName, buttonsLeftToRight[i])) return i;
        }

        return int.MaxValue;
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

    private static List<string> GetTaskbarButtonsLeftToRight()
    {
        var tray = AutomationElement.RootElement.FindFirst(
            TreeScope.Children, new PropertyCondition(AutomationElement.ClassNameProperty, "Shell_TrayWnd"));
        if (tray is null) return [];

        var buttons = tray.FindAll(
            TreeScope.Descendants, new PropertyCondition(AutomationElement.ClassNameProperty, TaskbarButtonClassName));

        var entries = new List<(string Name, double Left)>();
        foreach (AutomationElement button in buttons)
        {
            var name = button.Current.Name;
            if (string.IsNullOrEmpty(name)) continue;

            var stripped = RunningWindowsSuffix.Replace(name, string.Empty);
            stripped = PinnedSuffix.Replace(stripped, string.Empty).Trim();
            if (stripped.Length == 0) continue;

            entries.Add((stripped, button.Current.BoundingRectangle.Left));
        }

        return entries.OrderBy(e => e.Left).Select(e => e.Name).ToList();
    }
}
