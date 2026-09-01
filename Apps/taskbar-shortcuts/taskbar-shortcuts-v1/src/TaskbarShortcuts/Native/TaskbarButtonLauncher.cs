using System.Runtime.InteropServices;
using System.Threading;

namespace TaskbarShortcuts.Native;

/// <summary>
/// Launches a pinned-but-not-running taskbar icon the same way a real click would - the
/// taskbar button itself doesn't support the UI Automation Invoke pattern (verified: it
/// only exposes ScrollItemPattern), so this simulates an actual left-click at the button's
/// screen position via SendInput, then restores the cursor to where it was.
/// </summary>
internal static class TaskbarButtonLauncher
{
    public static void ClickAt(int screenX, int screenY)
    {
        NativeMethods.GetCursorPos(out var original);

        NativeMethods.SetCursorPos(screenX, screenY);

        var inputSize = Marshal.SizeOf<NativeMethods.INPUT>();
        SendMouseEvent(NativeMethods.MOUSEEVENTF_LEFTDOWN, inputSize);
        Thread.Sleep(30);
        SendMouseEvent(NativeMethods.MOUSEEVENTF_LEFTUP, inputSize);

        // Give the taskbar a moment to process the click before the cursor moves away.
        Thread.Sleep(50);
        NativeMethods.SetCursorPos(original.X, original.Y);
    }

    private static void SendMouseEvent(uint flags, int inputSize)
    {
        var inputs = new[]
        {
            new NativeMethods.INPUT { type = NativeMethods.INPUT_MOUSE, mi = new NativeMethods.MOUSEINPUT { dwFlags = flags } },
        };
        NativeMethods.SendInput((uint)inputs.Length, inputs, inputSize);
    }
}
