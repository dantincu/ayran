using System.Text;

namespace TaskbarShortcuts.Native;

internal static class WindowEnumerator
{
    /// <summary>
    /// Enumerates the windows that would show a taskbar button - the same filtering
    /// heuristic used by Alt-Tab style window switchers - and numbers them 1..N.
    /// </summary>
    public static List<TaskbarWindowInfo> GetTaskbarWindows(nint excludeHandle = 0)
    {
        var handles = new List<nint>();

        NativeMethods.EnumWindows((hWnd, _) =>
        {
            if (hWnd != excludeHandle && IsTaskbarWindow(hWnd))
            {
                handles.Add(hWnd);
            }
            return true;
        }, 0);

        var unordered = new List<TaskbarWindowInfo>(handles.Count);
        foreach (var hWnd in handles)
        {
            var title = GetWindowTitle(hWnd);
            NativeMethods.GetWindowThreadProcessId(hWnd, out var processId);

            unordered.Add(new TaskbarWindowInfo
            {
                Number = 0, // assigned below, once the final order is known
                Handle = hWnd,
                Title = title,
                Icon = IconExtractor.GetIconFor(hWnd, processId),
            });
        }

        var ordered = TaskbarOrderProvider.OrderByTaskbarPosition(unordered);

        var result = new List<TaskbarWindowInfo>(ordered.Count);
        var number = 1;
        foreach (var w in ordered)
        {
            result.Add(new TaskbarWindowInfo
            {
                Number = number++,
                Handle = w.Handle,
                Title = w.Title,
                Icon = w.Icon,
            });
        }

        return result;
    }

    private static bool IsTaskbarWindow(nint hWnd)
    {
        if (!NativeMethods.IsWindowVisible(hWnd)) return false;

        var exStyle = NativeMethods.GetWindowLong(hWnd, NativeMethods.GWL_EXSTYLE);

        var owner = NativeMethods.GetWindow(hWnd, NativeMethods.GW_OWNER);
        if (owner != 0 && (exStyle & NativeMethods.WS_EX_APPWINDOW) == 0)
        {
            return false;
        }

        if ((exStyle & NativeMethods.WS_EX_TOOLWINDOW) != 0)
        {
            return false;
        }

        if (IsCloaked(hWnd)) return false;

        var title = GetWindowTitle(hWnd);
        if (string.IsNullOrWhiteSpace(title)) return false;

        return true;
    }

    private static bool IsCloaked(nint hWnd)
    {
        var hr = NativeMethods.DwmGetWindowAttribute(
            hWnd, NativeMethods.DWMWA_CLOAKED, out var cloaked, sizeof(int));
        return hr == 0 && cloaked != 0;
    }

    private static string GetWindowTitle(nint hWnd)
    {
        var length = NativeMethods.GetWindowTextLength(hWnd);
        if (length == 0) return string.Empty;

        var sb = new StringBuilder(length + 1);
        NativeMethods.GetWindowText(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }
}
