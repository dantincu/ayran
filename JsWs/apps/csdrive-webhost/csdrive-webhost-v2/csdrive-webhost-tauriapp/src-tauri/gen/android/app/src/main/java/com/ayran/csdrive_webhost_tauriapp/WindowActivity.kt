package com.ayran.csdrive_webhost_tauriapp

import android.app.Activity
import android.app.ActivityManager
import android.app.AlertDialog
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.window.OnBackInvokedDispatcher
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.nio.ByteBuffer

/**
 * One window of a web app or a system app: an activity of its own, so it has its own entry in the Recents screen (see
 * [WindowBridge] and `docs/strategies/android-windows-strategy.md`).
 *
 * Its [WebView] is a plain one. Every page it shows comes from the Rust backend ([WindowBridge.nativeServe] answers each
 * request — nothing else is ever fetched: a request to any other host is refused), it may only be at its own page (a reload;
 * [WindowBridge.nativeNavigation] decides), and it reaches the backend through [Bridge] alone, created here for this window's
 * guid so that the page cannot pass itself off as another window.
 *
 * Back **suspends** the window (its entry and tabs are kept in the admin-app); *Close* in the admin-app closes it for good.
 */
class WindowActivity : Activity() {
    private var guid = ""
    private var web: WebView? = null
    private var chooser: ValueCallback<Array<Uri>>? = null

    // Whether the backend knows this window (only then may it be told that the window is gone).
    private var attached = false

    // The page's full screen (its viewer calls `requestFullscreen()`): the element the WebView hands over, shown over the whole
    // window with the system bars hidden, until the page — or Back — leaves it.
    private var customView: View? = null
    private var customViewDone: WebChromeClient.CustomViewCallback? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val id = intent.getStringExtra(EXTRA_GUID)
        if (id == null) {
            finishAndRemoveTask()
            return
        }
        guid = id

        // The backend answers with the page to show — or, if it doesn't know this window (the system brought the task back
        // after the app was killed, or it was closed meanwhile), nothing: the app is started and this window goes.
        val answer = if (WindowBridge.init(this)) WindowBridge.nativeAttach(id) else ""
        if (answer.isEmpty()) {
            startActivity(packageManager.getLaunchIntentForPackage(packageName))
            finishAndRemoveTask()
            return
        }
        attached = true
        val page = JSONObject(answer)
        setWindowTitle(page.optString("title", ""))

        val view = WebView(this)
        web = view
        view.setBackgroundColor(background())
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        view.addJavascriptInterface(Bridge(id), "CsdriveBridge")
        // A page calls the backend through a message port that **only the window's own page** — its main frame — can use. (A
        // JavaScript interface is injected into every frame, and can't tell which one calls: a page shown in a frame of a window, Notes'
        // User Action popup, could call as the window. A message listener is told whether the message came from the main frame, and
        // is only offered to the origins the window's pages are at.) No listener, no bridge: it fails closed.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(view, "CsdriveInvoke", setOf("http://csuser.localhost", "http://tauri.localhost")) { _, message, _, isMainFrame, _ ->
                if (!isMainFrame) return@addWebMessageListener
                val call = try { JSONObject(message.data ?: return@addWebMessageListener) } catch (e: Exception) { return@addWebMessageListener }
                WindowBridge.nativeInvoke(id, call.getString("cmd"), call.getString("args"), call.getInt("callback"), call.getInt("error"))
            }
        } else {
            Log.e("CsdriveWindow", "This WebView can't tell which frame calls: the window has no bridge.")
        }
        view.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(v: WebView, request: WebResourceRequest): WebResourceResponse? = serve(request)

            // A page in this window is only ever at its own address: the backend says whether a navigation may go ahead
            // (a link to the web opens the browser there and is refused here).
            override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean =
                !WindowBridge.nativeNavigation(id, request.url.toString())
        }
        view.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                Log.d("CsdriveWindow", "${message.sourceId()}:${message.lineNumber()} ${message.message()}")
                return true
            }

            // alert(), confirm() and prompt() of the page: native dialogs on this window — under the rules of the backend's prompt guard
            // (one prompt at a time, none once the person prevented them; docs/app-security.md), titled so that it is plain that it is the
            // *page* that is talking, not the app, and with the option to prevent prompts.
            override fun onJsAlert(v: WebView, url: String?, message: String?, result: JsResult): Boolean {
                if (!beginPageDialog(result)) return true
                AlertDialog.Builder(this@WindowActivity)
                    .setTitle(PAGE_SAYS)
                    .setMessage(message)
                    .setPositiveButton(android.R.string.ok) { _, _ -> WindowBridge.nativeDialogEnd(false); result.confirm() }
                    .setNeutralButton(PREVENT_PROMPTS) { _, _ -> WindowBridge.nativeDialogEnd(true); result.cancel() }
                    .setOnCancelListener { WindowBridge.nativeDialogEnd(false); result.cancel() }
                    .show()
                return true
            }

            override fun onJsConfirm(v: WebView, url: String?, message: String?, result: JsResult): Boolean {
                if (!beginPageDialog(result)) return true
                AlertDialog.Builder(this@WindowActivity)
                    .setTitle(PAGE_SAYS)
                    .setMessage(message)
                    .setPositiveButton(android.R.string.ok) { _, _ -> WindowBridge.nativeDialogEnd(false); result.confirm() }
                    .setNegativeButton(android.R.string.cancel) { _, _ -> WindowBridge.nativeDialogEnd(false); result.cancel() }
                    .setNeutralButton(PREVENT_PROMPTS) { _, _ -> WindowBridge.nativeDialogEnd(true); result.cancel() }
                    .setOnCancelListener { WindowBridge.nativeDialogEnd(false); result.cancel() }
                    .show()
                return true
            }

            override fun onJsPrompt(v: WebView, url: String?, message: String?, defaultValue: String?, result: JsPromptResult): Boolean {
                if (!beginPageDialog(result)) return true
                val input = EditText(this@WindowActivity).apply {
                    setText(defaultValue ?: "")
                    setSingleLine()
                    selectAll()
                }
                AlertDialog.Builder(this@WindowActivity)
                    .setTitle(PAGE_SAYS)
                    .setMessage(message)
                    .setView(input)
                    .setPositiveButton(android.R.string.ok) { _, _ -> WindowBridge.nativeDialogEnd(false); result.confirm(input.text.toString()) }
                    .setNegativeButton(android.R.string.cancel) { _, _ -> WindowBridge.nativeDialogEnd(false); result.cancel() }
                    .setNeutralButton(PREVENT_PROMPTS) { _, _ -> WindowBridge.nativeDialogEnd(true); result.cancel() }
                    .setOnCancelListener { WindowBridge.nativeDialogEnd(false); result.cancel() }
                    .show()
                return true
            }

            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (customView != null) {
                    callback.onCustomViewHidden()
                    return
                }
                customView = view
                customViewDone = callback
                view.setBackgroundColor(Color.BLACK)
                (window.decorView as ViewGroup).addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                setSystemBars(false)
            }

            override fun onHideCustomView() {
                val view = customView ?: return
                (window.decorView as ViewGroup).removeView(view)
                customView = null
                customViewDone?.onCustomViewHidden()
                customViewDone = null
                setSystemBars(true)
            }

            // <input type="file">: the system's chooser (a file's real path is never given to the page).
            override fun onShowFileChooser(v: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                chooser?.onReceiveValue(null)
                chooser = callback
                return try {
                    startActivityForResult(params.createIntent(), CHOOSE_FILE)
                    true
                } catch (e: Exception) {
                    chooser = null
                    false
                }
            }
        }

        // Edge to edge (Android 15+ does it for every app): keep the page out from under the bars, and above the keyboard.
        val root = FrameLayout(this)
        root.setBackgroundColor(background())
        root.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.setOnApplyWindowInsetsListener { v, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            } else {
                @Suppress("DEPRECATION")
                v.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            }
            insets
        }
        setContentView(root)

        // Back suspends the window. Android 13+ sends Back to a registered callback (and no longer calls onBackPressed once
        // an app opts in to predictive back, which targetSdk 36 does); older versions call onBackPressed.
        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { back() }
        }

        WindowBridge.register(id, this)
        if (WindowBridge.takeCloseWhenUp(id)) {
            finishAndRemoveTask()
            return
        }
        view.loadUrl(page.getString("url"))
    }

    /**
     * A dialog on this window (UI thread): `labels` is a json array of up to three buttons; `reply` gets the index of the one
     * pressed — or, when the dialog is dismissed (Back, a press outside), -1.
     */
    fun showDialog(title: String, message: String, labels: String, reply: (Int) -> Unit) {
        val names = JSONArray(labels)
        val builder = AlertDialog.Builder(this)
        if (title.isNotEmpty()) builder.setTitle(title)
        builder.setMessage(message)
        if (names.length() > 0) builder.setPositiveButton(names.getString(0)) { _, _ -> reply(0) }
        if (names.length() > 1) builder.setNegativeButton(names.getString(1)) { _, _ -> reply(1) }
        if (names.length() > 2) builder.setNeutralButton(names.getString(2)) { _, _ -> reply(2) }
        builder.setOnCancelListener { reply(-1) }
        builder.show()
    }

    /** The title of this window's card in the Recents screen (the backend keeps it in step with the tab the page shows). */
    fun setWindowTitle(title: String) {
        @Suppress("DEPRECATION")
        setTaskDescription(ActivityManager.TaskDescription(title))
    }

    /** Runs `js` in the page. */
    fun evaluate(js: String) {
        web?.evaluateJavascript(js, null)
    }

    /** Back leaves the page's full screen first; only then does it suspend the window. */
    private fun back() {
        if (customView != null) web?.webChromeClient?.onHideCustomView() else finishAndRemoveTask()
    }

    /** Shows or hides the status and navigation bars (the page's full screen hides them; they come back with a swipe). */
    private fun setSystemBars(visible: Boolean) {
        if (Build.VERSION.SDK_INT >= 30) {
            window.insetsController?.let {
                if (visible) it.show(WindowInsets.Type.systemBars()) else it.hide(WindowInsets.Type.systemBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = if (visible) View.SYSTEM_UI_FLAG_VISIBLE else (
                View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                )
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        back()
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == CHOOSE_FILE) {
            chooser?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            chooser = null
        } else {
            @Suppress("DEPRECATION")
            super.onActivityResult(requestCode, resultCode, data)
        }
    }

    override fun onDestroy() {
        if (guid.isNotEmpty()) WindowBridge.unregister(guid, this)
        chooser?.onReceiveValue(null)
        chooser = null
        web?.let {
            it.stopLoading()
            it.destroy()
        }
        web = null
        // Only when the window is really over (Back, closed, swiped away) — not when the system merely frees an activity in
        // the background, which it brings back (the page is asked for again, in onCreate).
        if (isFinishing && attached) WindowBridge.nativeDetached(guid)
        super.onDestroy()
    }

    private fun background(): Int {
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        return if (night) 0xFF111318.toInt() else 0xFFFFFFFF.toInt()
    }

    /**
     * The answer to one request of the page: from the backend, for its own origins; anything else is refused (a second wall
     * behind the page's Content-Security-Policy). The backend's answer is `status | header json length | header json | body`.
     */
    private fun serve(request: WebResourceRequest): WebResourceResponse? {
        val url = request.url
        val host = url.host ?: return null // not a network request (data:, blob:…): the WebView's own
        val ours = host == "csuser.localhost" || host == "tauri.localhost" || host == "ipc.localhost"
        if (!ours || request.method != "GET") return refused()
        // A range (a video being played or sought) is answered a piece at a time; the origin lets the app's own page read a picture back.
        val frame = WindowBridge.nativeServe(guid, url.toString(), request.requestHeaders["Range"] ?: "", request.requestHeaders["Origin"] ?: "") ?: return refused()
        val buffer = ByteBuffer.wrap(frame)
        val status = buffer.int
        val headerBytes = ByteArray(buffer.int)
        buffer.get(headerBytes)
        val headers = JSONObject(String(headerBytes, Charsets.UTF_8))
        val body = ByteArray(buffer.remaining())
        buffer.get(body)

        val map = HashMap<String, String>()
        for (name in headers.keys()) map[name] = headers.getString(name)
        val contentType = map["content-type"] ?: "application/octet-stream"
        val mime = contentType.substringBefore(';').trim()
        val charset = Regex("charset=([^;]+)", RegexOption.IGNORE_CASE).find(contentType)?.groupValues?.get(1)?.trim()
        map.remove("content-type")
        return WebResourceResponse(mime, charset, status, reason(status), map, ByteArrayInputStream(body))
    }

    private fun refused() = WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream("Forbidden".toByteArray()))

    private fun reason(status: Int) = when (status) {
        200 -> "OK"
        206 -> "Partial Content"
        416 -> "Range Not Satisfiable"
        403 -> "Forbidden"
        404 -> "Not Found"
        else -> if (status in 200..299) "OK" else "Error"
    }

    /** May the page's own dialog be shown now? If not (prompts prevented, or another showing) the page's call is cancelled at once. */
    private fun beginPageDialog(result: JsResult): Boolean {
        if (WindowBridge.nativeDialogBegin() == 0) return true
        result.cancel()
        return false
    }

    /**
     * What every frame of the page can see: this window's label, and nothing else — no way to call the backend (that is the message
     * port above, for the main frame only) and none to show a native dialog of its own (the questions a page may ask go through
     * the backend's `confirm_dialog`, under the rules of its prompt guard).
     */
    private inner class Bridge(private val id: String) {
        @JavascriptInterface
        fun label(): String = id

    }

    companion object {
        const val EXTRA_GUID = "guid"
        const val EXTRA_TITLE = "title"
        private const val CHOOSE_FILE = 1
        private const val PAGE_SAYS = "A web page says"
        private const val PREVENT_PROMPTS = "Prevent this app from showing prompts"
    }
}
