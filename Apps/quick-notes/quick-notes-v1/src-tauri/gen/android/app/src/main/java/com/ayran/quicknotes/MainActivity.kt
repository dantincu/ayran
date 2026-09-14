package com.ayran.quicknotes

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

class MainActivity : TauriActivity() {
  private var webView: WebView? = null
  private var pendingProcessText: String? = null
  private var pendingProcessTextReadonly: Boolean = true

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    capturePendingProcessText(intent)
    super.onCreate(savedInstanceState)

    // enableEdgeToEdge() lets our WebView draw behind the system bars, but doesn't
    // tell it where those bars are - the WebView has no browser chrome to compute
    // env(safe-area-inset-*) from, so without this it just renders under them.
    // Padding the content view natively shrinks the WebView's own viewport to the
    // safe area instead.
    val contentView = findViewById<android.view.View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(contentView) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      val bottom = maxOf(bars.bottom, ime.bottom)
      view.setPadding(bars.left, bars.top, bars.right, bottom)
      Log.d(
        "QuickNotesInsets",
        "top=${bars.top} bottom=${bars.bottom} ime=${ime.bottom} left=${bars.left} right=${bars.right}"
      )
      insets
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    this.webView = webView
    webView.addJavascriptInterface(ProcessTextBridge(this), "AndroidProcessText")
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    // The app (and its webview/JS) is already running at this point (singleTask
    // launch mode only re-delivers via onNewIntent to an existing instance), so
    // push the new text straight to the frontend instead of queuing it for pull.
    if (intent.action == Intent.ACTION_PROCESS_TEXT) {
      val text = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString() ?: return
      val readonly = intent.getBooleanExtra(Intent.EXTRA_PROCESS_TEXT_READONLY, true)
      dispatchProcessTextEvent(text, readonly)
    }
  }

  private fun capturePendingProcessText(intent: Intent?) {
    if (intent?.action != Intent.ACTION_PROCESS_TEXT) return
    val text = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString() ?: return
    pendingProcessText = text
    pendingProcessTextReadonly = intent.getBooleanExtra(Intent.EXTRA_PROCESS_TEXT_READONLY, true)
  }

  private fun dispatchProcessTextEvent(text: String, readonly: Boolean) {
    val payload = JSONObject().put("text", text).put("readonly", readonly).toString()
      // U+2028/U+2029 are valid in JSON strings but historically illegal as raw,
      // unescaped line terminators inside a JS string literal - escape them so the
      // spliced-in payload below can't break older WebView JS engines.
      .replace(" ", "\\u2028")
      .replace(" ", "\\u2029")
    val webView = this.webView ?: return
    webView.post {
      webView.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('android-process-text', { detail: $payload }))",
        null,
      )
    }
  }

  private inner class ProcessTextBridge(private val activity: MainActivity) {
    @JavascriptInterface
    fun getPendingText(): String {
      val text = activity.pendingProcessText ?: return "null"
      val readonly = activity.pendingProcessTextReadonly
      activity.pendingProcessText = null
      return JSONObject().put("text", text).put("readonly", readonly).toString()
    }

    @JavascriptInterface
    fun sendTextOut(text: String) {
      activity.runOnUiThread {
        activity.setResult(Activity.RESULT_OK, Intent().putExtra(Intent.EXTRA_PROCESS_TEXT, text))
        activity.finish()
      }
    }
  }
}
