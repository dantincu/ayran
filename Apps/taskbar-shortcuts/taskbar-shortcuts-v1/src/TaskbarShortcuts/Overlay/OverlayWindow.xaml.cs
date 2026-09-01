using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
using TaskbarShortcuts.Native;

namespace TaskbarShortcuts.Overlay;

internal partial class OverlayWindow : Window
{
    private const double TopMargin = 40;
    private const double ListHeightReserve = 160; // header + buffer row + borders/padding

    private readonly List<WindowRowViewModel> _rows = new();
    private string _buffer = string.Empty;
    private bool _closed;

    public OverlayWindow()
    {
        InitializeComponent();

        // Enumerate once the HWND exists (but before first paint) so we can exclude
        // ourselves from the list and size the window correctly with no visible flicker.
        SourceInitialized += (_, _) => PopulateRows();
    }

    private void PopulateRows()
    {
        var selfHandle = new WindowInteropHelper(this).Handle;
        var windows = WindowEnumerator.GetTaskbarWindows(selfHandle);
        _rows.AddRange(windows.Select(w => new WindowRowViewModel(w)));
        WindowsList.ItemsSource = _rows;

        ListScroller.MaxHeight = Math.Max(100, SystemParameters.WorkArea.Height - TopMargin - ListHeightReserve);
    }

    private void OverlayWindow_Loaded(object sender, RoutedEventArgs e)
    {
        var workArea = SystemParameters.WorkArea;
        Left = workArea.Left + (workArea.Width - ActualWidth) / 2;
    }

    private void OverlayWindow_ContentRendered(object sender, EventArgs e)
    {
        // Opened from a global hotkey, so this window is not the foreground app yet -
        // force it into the foreground so keyboard input actually reaches it.
        var hwnd = new WindowInteropHelper(this).Handle;
        WindowActivator.Activate(hwnd);
        Keyboard.Focus(this);
    }

    private void OverlayWindow_Deactivated(object sender, EventArgs e) => CloseOverlay();

    private void OverlayWindow_PreviewKeyDown(object sender, System.Windows.Input.KeyEventArgs e)
    {
        if (e.Key == Key.Escape)
        {
            CloseOverlay();
            e.Handled = true;
            return;
        }

        if (e.Key == Key.Enter || e.Key == Key.Return)
        {
            TryActivateBuffered();
            e.Handled = true;
            return;
        }

        if (e.Key == Key.Back)
        {
            if (_buffer.Length > 0) _buffer = _buffer[..^1];
            UpdateHighlight();
            e.Handled = true;
            return;
        }

        var digit = KeyToDigit(e.Key);
        if (digit >= 0)
        {
            _buffer += digit.ToString();
            UpdateHighlight();
            e.Handled = true;
        }
    }

    private static int KeyToDigit(Key key) => key switch
    {
        >= Key.D0 and <= Key.D9 => key - Key.D0,
        >= Key.NumPad0 and <= Key.NumPad9 => key - Key.NumPad0,
        _ => -1,
    };

    private void UpdateHighlight()
    {
        BufferText.Text = _buffer;
        var target = ParseBuffer();
        foreach (var row in _rows)
        {
            row.IsHighlighted = target.HasValue && row.Number == target.Value;
        }
    }

    private int? ParseBuffer()
        => int.TryParse(_buffer, out var value) ? value : null;

    private void TryActivateBuffered()
    {
        var target = ParseBuffer();
        if (target is null) return;

        var row = _rows.FirstOrDefault(r => r.Number == target.Value);
        if (row is null) return;

        CloseOverlay();
        WindowActivator.Activate(row.Handle);
    }

    private void Row_MouseLeftButtonUp(object sender, MouseButtonEventArgs e)
    {
        if (sender is not FrameworkElement { DataContext: WindowRowViewModel row }) return;

        CloseOverlay();
        WindowActivator.Activate(row.Handle);
    }

    private void CloseOverlay()
    {
        if (_closed) return;
        _closed = true;
        Close();
    }
}
