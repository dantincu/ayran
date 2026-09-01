using System.Text;

namespace TaskbarShortcuts.Overlay;

/// <summary>
/// Bijective base-26 letters for addressing a window within a grouped taskbar icon -
/// the same scheme spreadsheet columns use (a, b, ..., z, aa, ab, ...), 1-indexed.
/// </summary>
internal static class SelectorCode
{
    public static string IndexToLetters(int oneBasedIndex)
    {
        var sb = new StringBuilder();
        var n = oneBasedIndex;
        while (n > 0)
        {
            var remainder = (n - 1) % 26;
            sb.Insert(0, (char)('a' + remainder));
            n = (n - 1) / 26;
        }
        return sb.ToString();
    }
}
