using System.Windows.Media;

namespace TaskbarShortcuts.Native;

/// <summary>
/// One taskbar icon and everything selectable through it: zero real windows (a pinned icon
/// with nothing open - selecting it clicks the real taskbar button to launch it), one window,
/// or several (grouped under the same taskbar button, e.g. multiple browser windows).
/// </summary>
internal sealed class TaskbarIconGroup
{
    public required int Number { get; init; }
    public required string DisplayName { get; init; }
    public ImageSource? Icon { get; init; }
    public required List<TaskbarWindowInfo> Windows { get; init; }
    public Action? Launch { get; init; }
}
