using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Windows.Media;
using TaskbarShortcuts.Native;

namespace TaskbarShortcuts.Overlay;

internal sealed class WindowRowViewModel : INotifyPropertyChanged
{
    private bool _isHighlighted;

    public int Number { get; }

    /// <summary>Null for a single-window group or a placeholder; set for each window in a
    /// multi-window group (bijective base-26: "a", "b", ..., "z", "aa", ...).</summary>
    public string? Letter { get; }

    public string SelectorCode { get; }
    public string Title { get; }
    public ImageSource? Icon { get; }

    /// <summary>True when this row has no open window - selecting it launches the app instead.</summary>
    public bool IsPlaceholder { get; }

    private readonly nint _handle;
    private readonly Action? _launch;

    public bool IsHighlighted
    {
        get => _isHighlighted;
        set
        {
            if (_isHighlighted == value) return;
            _isHighlighted = value;
            OnPropertyChanged();
        }
    }

    public static WindowRowViewModel ForWindow(int number, string? letter, TaskbarWindowInfo window)
        => new(number, letter, window.Title, window.Icon, isPlaceholder: false, window.Handle, launch: null);

    public static WindowRowViewModel ForPlaceholder(TaskbarIconGroup group)
        => new(group.Number, letter: null, group.DisplayName, group.Icon, isPlaceholder: true, handle: 0, group.Launch);

    private WindowRowViewModel(int number, string? letter, string title, ImageSource? icon, bool isPlaceholder, nint handle, Action? launch)
    {
        Number = number;
        Letter = letter;
        SelectorCode = number + (letter ?? string.Empty);
        Title = title;
        Icon = icon;
        IsPlaceholder = isPlaceholder;
        _handle = handle;
        _launch = launch;
    }

    public void Select()
    {
        if (_launch is not null) _launch();
        else WindowActivator.Activate(_handle);
    }

    public event PropertyChangedEventHandler? PropertyChanged;

    private void OnPropertyChanged([CallerMemberName] string? name = null)
        => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}
