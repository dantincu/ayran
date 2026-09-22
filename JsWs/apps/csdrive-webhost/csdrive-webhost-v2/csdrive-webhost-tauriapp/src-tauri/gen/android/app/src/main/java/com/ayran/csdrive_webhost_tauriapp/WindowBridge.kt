package com.ayran.csdrive_webhost_tauriapp

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import java.util.concurrent.ConcurrentHashMap

/**
 * The Kotlin half of the bridge between the windows of web apps and system apps and the Rust backend (see
 * `android_windows.rs` and `docs/strategies/android-windows-strategy.md`).
 *
 * Every window is a [WindowActivity] with a plain WebView of its own. **Which window is calling is decided here, by the
 * activity** — each activity's JavaScript interface is created for one guid — never by anything the page says.
 *
 * - The `native…` functions are implemented in Rust (JNI): they are how a window asks for its page, sends a command, asks
 *   for a file, asks whether it may navigate, and says it is gone.
 * - The `@JvmStatic` functions below are what Rust calls (from any thread): open, close, run script, answer a command.
 */
object WindowBridge {
    private val windows = ConcurrentHashMap<String, WindowActivity>()

    // Windows Rust asked to close before their activity had come up.
    private val closeWhenUp: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private val ui = Handler(Looper.getMainLooper())

    @Volatile private var context: Context? = null

    @Volatile private var ready = false

    @JvmStatic external fun nativeInit()

    @JvmStatic external fun nativeAttach(guid: String): String

    @JvmStatic external fun nativeInvoke(guid: String, cmd: String, args: String, callback: Int, error: Int)

    @JvmStatic external fun nativeServe(guid: String, url: String, range: String, origin: String): ByteArray?

    @JvmStatic external fun nativeNavigation(guid: String, url: String): Boolean

    @JvmStatic external fun nativeDetached(guid: String)

    @JvmStatic external fun nativeAnswer(id: Int, index: Int)

    /** A page is about to show its own dialog (alert, confirm, prompt): 0 — go ahead (and call [nativeDialogEnd] when it is over), 1 — the
     * person prevented prompts, 2 — another prompt is showing. One prompt at a time, and none once they are prevented: `prompt_guard.rs`. */
    @JvmStatic external fun nativeDialogBegin(): Int

    /** The page's own dialog is over; `prevent`: the person pressed *Prevent this app from showing prompts* in it. */
    @JvmStatic external fun nativeDialogEnd(prevent: Boolean)

    /**
     * Makes the native functions usable and gives Rust this class. Called by the app's own activity and by every window: a
     * window the system brings back after the process was killed may run before the app's activity does, so it loads the
     * library itself — and finds that the app isn't running (the backend answers nothing) and starts it.
     */
    @JvmStatic
    fun init(context: Context): Boolean {
        this.context = context.applicationContext
        if (ready) return true
        return try {
            System.loadLibrary("csdrive_webhost_tauriapp_lib")
            nativeInit()
            ready = true
            true
        } catch (e: UnsatisfiedLinkError) {
            false
        }
    }

    fun register(guid: String, activity: WindowActivity) {
        windows[guid] = activity
    }

    fun unregister(guid: String, activity: WindowActivity) {
        if (windows[guid] === activity) windows.remove(guid)
    }

    /** Whether Rust asked, before the activity was up, for the window to be closed (and forgets it). */
    fun takeCloseWhenUp(guid: String): Boolean = closeWhenUp.remove(guid)

    // ── What Rust calls ─────────────────────────────────────────────────────────

    /** Shows the window: starts its activity, or — if it is showing (`documentLaunchMode="intoExisting"`) — brings it to the front. */
    @JvmStatic
    fun open(guid: String, title: String) {
        val app = context ?: return
        ui.post {
            app.startActivity(
                Intent(app, WindowActivity::class.java)
                    .setData(Uri.parse("csdrive-window://$guid")) // what tells one window's task from another's
                    .putExtra(WindowActivity.EXTRA_GUID, guid)
                    .putExtra(WindowActivity.EXTRA_TITLE, title)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NEW_DOCUMENT),
            )
        }
    }

    /** Closes the window and removes it from the Recents screen. */
    @JvmStatic
    fun close(guid: String) {
        ui.post {
            val activity = windows[guid]
            if (activity != null) activity.finishAndRemoveTask() else closeWhenUp.add(guid)
        }
    }

    /** The title of the window's card in the Recents screen. */
    @JvmStatic
    fun title(guid: String, title: String) {
        ui.post { windows[guid]?.setWindowTitle(title) }
    }

    /** Runs `js` in the window's page. */
    @JvmStatic
    fun eval(guid: String, js: String) {
        ui.post { windows[guid]?.evaluate(js) }
    }

    /** Asks the person something in a dialog of the window's own activity; `labels` is a json array of up to three buttons. */
    @JvmStatic
    fun ask(guid: String, id: String, title: String, message: String, labels: String) {
        ui.post {
            val activity = windows[guid]
            if (activity != null) activity.showDialog(title, message, labels) { index -> nativeAnswer(id.toInt(), index) } else nativeAnswer(id.toInt(), -1)
        }
    }

    /**
     * The answer to a command the window's page sent. `kind` is `json` — `payload` is the value, as json — or `raw` — `payload`
     * is `<error callback id>:<key>` and the page fetches the bytes itself (`window.__csdriveRaw`).
     */
    @JvmStatic
    fun respond(guid: String, id: String, kind: String, payload: String) {
        val js = if (kind == "raw") {
            val (errorId, key) = payload.split(':', limit = 2)
            "window.__csdriveRaw($id, $errorId, $key)"
        } else {
            "window.__TAURI_INTERNALS__.runCallback($id, $payload)"
        }
        eval(guid, js)
    }
}
