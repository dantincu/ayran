using System.Threading;
using System.Windows;
using TaskbarShortcuts.Native;
using TaskbarShortcuts.Overlay;
using Forms = System.Windows.Forms;

namespace TaskbarShortcuts;

public partial class App : System.Windows.Application
{
    private const string SingleInstanceMutexName = "TaskbarShortcuts-SingleInstance-Mutex";

    private HotkeyManager? _hotkeyManager;
    private Forms.NotifyIcon? _trayIcon;
    private OverlayWindow? _overlayWindow;
    private Mutex? _singleInstanceMutex;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        _singleInstanceMutex = new Mutex(initiallyOwned: true, SingleInstanceMutexName, out var createdNew);
        if (!createdNew)
        {
            // Already running (e.g. launched at login and again by hand) - just exit.
            Shutdown();
            return;
        }

        _trayIcon = CreateTrayIcon();

        _hotkeyManager = new HotkeyManager();
        _hotkeyManager.HotkeyPressed += ShowOverlay;

        if (!_hotkeyManager.IsRegistered)
        {
            _trayIcon.ShowBalloonTip(
                4000,
                "Taskbar Shortcuts",
                "Could not register the Ctrl+Alt+T hotkey - it may already be in use by another app.",
                Forms.ToolTipIcon.Warning);
        }
    }

    private Forms.NotifyIcon CreateTrayIcon()
    {
        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add("Show list (Ctrl+Alt+T)", null, (_, _) => ShowOverlay());
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => Shutdown());

        var icon = new Forms.NotifyIcon
        {
            Icon = System.Drawing.SystemIcons.Application,
            Visible = true,
            Text = "Taskbar Shortcuts",
            ContextMenuStrip = menu,
        };
        icon.DoubleClick += (_, _) => ShowOverlay();
        return icon;
    }

    private void ShowOverlay()
    {
        if (_overlayWindow is not null)
        {
            _overlayWindow.Activate();
            return;
        }

        _overlayWindow = new OverlayWindow();
        _overlayWindow.Closed += (_, _) => _overlayWindow = null;
        _overlayWindow.Show();
        _overlayWindow.Activate();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _hotkeyManager?.Dispose();
        _trayIcon?.Dispose();
        _singleInstanceMutex?.Dispose();
        base.OnExit(e);
    }
}
