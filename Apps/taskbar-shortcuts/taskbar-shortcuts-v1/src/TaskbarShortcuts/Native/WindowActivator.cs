namespace TaskbarShortcuts.Native;

internal static class WindowActivator
{
    /// <summary>
    /// Brings an already-open window into view and gives it focus - restoring it if
    /// minimized - without launching a new instance.
    /// </summary>
    public static void Activate(nint hWnd)
    {
        if (NativeMethods.IsIconic(hWnd))
        {
            NativeMethods.ShowWindow(hWnd, NativeMethods.SW_RESTORE);
        }
        else
        {
            NativeMethods.ShowWindow(hWnd, NativeMethods.SW_SHOW);
        }

        var foregroundWindow = NativeMethods.GetForegroundWindow();
        var currentThreadId = NativeMethods.GetCurrentThreadId();
        var foregroundThreadId = NativeMethods.GetWindowThreadProcessId(foregroundWindow, out _);

        var attached = foregroundThreadId != currentThreadId
            && NativeMethods.AttachThreadInput(currentThreadId, foregroundThreadId, true);

        try
        {
            NativeMethods.SetForegroundWindow(hWnd);
        }
        finally
        {
            if (attached)
            {
                NativeMethods.AttachThreadInput(currentThreadId, foregroundThreadId, false);
            }
        }
    }
}
