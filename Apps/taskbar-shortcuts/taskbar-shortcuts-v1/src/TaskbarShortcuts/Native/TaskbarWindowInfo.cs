using System.Windows.Media;

namespace TaskbarShortcuts.Native;

internal sealed class TaskbarWindowInfo
{
    public required int Number { get; init; }
    public required nint Handle { get; init; }
    public required string Title { get; init; }
    public ImageSource? Icon { get; init; }
}
