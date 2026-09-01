using System.Windows.Interop;

namespace TaskbarShortcuts.Native;

internal sealed class HotkeyManager : IDisposable
{
    private const int HotkeyId = 0xA000;
    private const uint VkT = 0x54;

    private readonly HwndSource _source;
    private bool _registered;

    public event Action? HotkeyPressed;

    public HotkeyManager()
    {
        // A hidden message-only window purely to receive WM_HOTKEY.
        var parameters = new HwndSourceParameters("TaskbarShortcutsHotkeyWindow")
        {
            Width = 0,
            Height = 0,
            WindowStyle = 0,
            ParentWindow = new nint(-3), // HWND_MESSAGE
        };
        _source = new HwndSource(parameters);
        _source.AddHook(WndProc);

        _registered = NativeMethods.RegisterHotKey(
            _source.Handle, HotkeyId, NativeMethods.MOD_CONTROL | NativeMethods.MOD_ALT, VkT);
    }

    public bool IsRegistered => _registered;

    private nint WndProc(nint hwnd, int msg, nint wParam, nint lParam, ref bool handled)
    {
        if (msg == NativeMethods.WM_HOTKEY && wParam.ToInt32() == HotkeyId)
        {
            HotkeyPressed?.Invoke();
            handled = true;
        }
        return 0;
    }

    public void Dispose()
    {
        if (_registered)
        {
            NativeMethods.UnregisterHotKey(_source.Handle, HotkeyId);
            _registered = false;
        }
        _source.RemoveHook(WndProc);
        _source.Dispose();
    }
}
