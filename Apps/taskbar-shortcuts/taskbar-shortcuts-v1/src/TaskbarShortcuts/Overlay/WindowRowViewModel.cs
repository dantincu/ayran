using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Windows.Media;
using TaskbarShortcuts.Native;

namespace TaskbarShortcuts.Overlay;

internal sealed class WindowRowViewModel : INotifyPropertyChanged
{
    private bool _isHighlighted;

    public int Number { get; }
    public nint Handle { get; }
    public string Title { get; }
    public ImageSource? Icon { get; }

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

    public WindowRowViewModel(TaskbarWindowInfo info)
    {
        Number = info.Number;
        Handle = info.Handle;
        Title = info.Title;
        Icon = info.Icon;
    }

    public event PropertyChangedEventHandler? PropertyChanged;

    private void OnPropertyChanged([CallerMemberName] string? name = null)
        => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}
