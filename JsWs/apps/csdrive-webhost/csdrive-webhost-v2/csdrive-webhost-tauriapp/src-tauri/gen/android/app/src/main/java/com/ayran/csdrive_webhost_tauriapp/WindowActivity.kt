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
import android.view.ViewGroup
import android.view.WindowInsets
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.JsResult
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
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
        val title = page.optString("title", "")
        @Suppress("DEPRECATION")
        setTaskDescription(ActivityManager.TaskDescription(title))

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

            // alert() and confirm() of the page: native dialogs on this window.
            override fun onJsAlert(v: WebView, url: String?, message: String?, result: JsResult): Boolean {
                AlertDialog.Builder(this@WindowActivity)
                    .setMessage(message)
                    .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                    .setOnCancelListener { result.cancel() }
                    .show()
                return true
            }

            override fun onJsConfirm(v: WebView, url: String?, message: String?, result: JsResult): Boolean {
                AlertDialog.Builder(this@WindowActivity)
                    .setMessage(message)
                    .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                    .setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
                    .setOnCancelListener { result.cancel() }
                    .show()
                return true
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
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { finishAndRemoveTask() }
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

    /** Runs `js` in the page. */
    fun evaluate(js: String) {
        web?.evaluateJavascript(js, null)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        finishAndRemoveTask()
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
        val frame = WindowBridge.nativeServe(guid, url.toString()) ?: return refused()
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
        403 -> "Forbidden"
        404 -> "Not Found"
        else -> if (status in 200..299) "OK" else "Error"
    }

    /**
     * What the page can call: [WindowBridge]'s functions on behalf of **this** window (the guid is fixed here), and a native
     * dialog on this activity. Nothing else is exposed to the page.
     */
    private inner class Bridge(private val id: String) {
        @JavascriptInterface
        fun label(): String = id

        @JavascriptInterface
        fun invoke(cmd: String, args: String, callback: Int, error: Int) {
            WindowBridge.nativeInvoke(id, cmd, args, callback, error)
        }

        /** `plugin-dialog`'s message dialog: up to three buttons (`labels` is a json array); `answer` is called with the index pressed. */
        @JavascriptInterface
        fun dialog(title: String, message: String, labels: String, answer: Int) {
            runOnUiThread {
                showDialog(title, message, labels) { index -> evaluate("window.__TAURI_INTERNALS__.runCallback($answer, $index)") }
            }
        }
    }

    companion object {
        const val EXTRA_GUID = "guid"
        const val EXTRA_TITLE = "title"
        private const val CHOOSE_FILE = 1
    }
}
