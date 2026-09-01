using System.Drawing;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace TaskbarShortcuts.Native;

/// <summary>
/// A pinned-but-not-running taskbar icon has no window/process to pull an icon from, so
/// instead this grabs a screenshot of the icon area straight off the taskbar button - a
/// pixel-perfect match with no exe/shortcut lookup needed.
/// </summary>
internal static class ButtonIconCapture
{
    public static ImageSource? CaptureIcon(int boundsX, int boundsY, int boundsWidth, int boundsHeight)
    {
        try
        {
            var size = Math.Max(1, Math.Min(boundsWidth, boundsHeight) - 8);
            var x = boundsX + (boundsWidth - size) / 2;
            var y = boundsY + (boundsHeight - size) / 2;

            using var bitmap = new Bitmap(size, size, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bitmap))
            {
                g.CopyFromScreen(x, y, 0, 0, new System.Drawing.Size(size, size));
            }

            var hBitmap = bitmap.GetHbitmap();
            try
            {
                var source = Imaging.CreateBitmapSourceFromHBitmap(
                    hBitmap, IntPtr.Zero, Int32Rect.Empty, BitmapSizeOptions.FromEmptyOptions());
                source.Freeze();
                return source;
            }
            finally
            {
                NativeMethods.DeleteObject(hBitmap);
            }
        }
        catch
        {
            return null;
        }
    }
}
