using System.Diagnostics;
using System.Drawing;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace TaskbarShortcuts.Native;

internal static class IconExtractor
{
    public static ImageSource? GetIconFor(nint hWnd, uint processId)
    {
        var hIcon = SendGetIcon(hWnd, NativeMethods.ICON_SMALL2);
        if (hIcon == 0) hIcon = SendGetIcon(hWnd, NativeMethods.ICON_SMALL);
        if (hIcon == 0) hIcon = SendGetIcon(hWnd, NativeMethods.ICON_BIG);
        if (hIcon == 0) hIcon = NativeMethods.GetClassLongPtr(hWnd, NativeMethods.GCL_HICONSM);
        if (hIcon == 0) hIcon = NativeMethods.GetClassLongPtr(hWnd, NativeMethods.GCL_HICON);

        if (hIcon != 0)
        {
            var source = TryCreateFromHIcon(hIcon);
            if (source != null) return source;
        }

        return GetIconFromProcess(processId);
    }

    private static nint SendGetIcon(nint hWnd, int type)
        => NativeMethods.SendMessage(hWnd, NativeMethods.WM_GETICON, type, 0);

    private static ImageSource? GetIconFromProcess(uint processId)
    {
        try
        {
            using var process = Process.GetProcessById((int)processId);
            var path = process.MainModule?.FileName;
            if (string.IsNullOrEmpty(path)) return null;

            using var icon = Icon.ExtractAssociatedIcon(path);
            if (icon == null) return null;

            return TryCreateFromHIcon(icon.Handle);
        }
        catch
        {
            return null;
        }
    }

    // Note: the HICONs we read here (WM_GETICON / GCL_HICON, and Icon.ExtractAssociatedIcon)
    // are owned by the target process or by the managed Icon wrapper respectively - we must not
    // call DestroyIcon on them ourselves.
    private static ImageSource? TryCreateFromHIcon(nint hIcon)
    {
        try
        {
            var source = Imaging.CreateBitmapSourceFromHIcon(
                hIcon, Int32Rect.Empty, BitmapSizeOptions.FromEmptyOptions());
            source.Freeze();
            return source;
        }
        catch
        {
            return null;
        }
    }
}
