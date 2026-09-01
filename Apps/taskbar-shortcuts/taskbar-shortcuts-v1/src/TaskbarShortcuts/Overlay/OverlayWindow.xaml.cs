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
    private string _digits = string.Empty;
    private string _letters = string.Empty;
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
        var groups = TaskbarIconGrouper.BuildGroups(windows);

        foreach (var group in groups)
        {
            if (group.Windows.Count == 0)
            {
                _rows.Add(WindowRowViewModel.ForPlaceholder(group));
            }
            else if (group.Windows.Count == 1)
            {
                _rows.Add(WindowRowViewModel.ForWindow(group.Number, letter: null, group.Windows[0]));
            }
            else
            {
                for (var i = 0; i < group.Windows.Count; i++)
                {
                    var letters = SelectorCode.IndexToLetters(i + 1);
                    _rows.Add(WindowRowViewModel.ForWindow(group.Number, letters, group.Windows[i]));
                }
            }
        }

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
            TrySelectBuffered();
            e.Handled = true;
            return;
        }

        if (e.Key == Key.Back)
        {
            if (_letters.Length > 0) _letters = _letters[..^1];
            else if (_digits.Length > 0) _digits = _digits[..^1];
            UpdateHighlight();
            e.Handled = true;
            return;
        }

        // Digits open the icon number; once a letter has been typed, the number is closed.
        var digit = KeyToDigit(e.Key);
        if (digit >= 0 && _letters.Length == 0)
        {
            _digits += digit.ToString();
            UpdateHighlight();
            e.Handled = true;
            return;
        }

        // Letters disambiguate a window within a grouped icon; need a number typed first.
        var letter = KeyToLetter(e.Key);
        if (letter is not null && _digits.Length > 0)
        {
            _letters += letter.Value;
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

    private static char? KeyToLetter(Key key)
        => key is >= Key.A and <= Key.Z ? (char)('a' + (key - Key.A)) : null;

    private void UpdateHighlight()
    {
        BufferText.Text = _digits + _letters;
        var number = ParseNumber();
        foreach (var row in _rows)
        {
            row.IsHighlighted = number.HasValue && row.Number == number.Value
                && (_letters.Length == 0 || string.Equals(row.Letter, _letters, StringComparison.Ordinal));
        }
    }

    private int? ParseNumber()
        => int.TryParse(_digits, out var value) ? value : null;

    private void TrySelectBuffered()
    {
        var number = ParseNumber();
        if (number is null) return;

        var row = FindRow(number.Value, _letters);
        if (row is null) return;

        CloseOverlay();
        row.Select();
    }

    /// <summary>Finds the row for a number + optional letters. With no letters, resolves to
    /// the group's only row (single window or placeholder) or the group's first window.</summary>
    private WindowRowViewModel? FindRow(int number, string letters)
        => letters.Length > 0
            ? _rows.FirstOrDefault(r => r.Number == number && r.Letter == letters)
            : _rows.FirstOrDefault(r => r.Number == number && (r.Letter is null || r.Letter == "a"));

    private void Row_MouseLeftButtonUp(object sender, MouseButtonEventArgs e)
    {
        if (sender is not FrameworkElement { DataContext: WindowRowViewModel row }) return;

        CloseOverlay();
        row.Select();
    }

    private void CloseOverlay()
    {
        if (_closed) return;
        _closed = true;
        Close();
    }
}
