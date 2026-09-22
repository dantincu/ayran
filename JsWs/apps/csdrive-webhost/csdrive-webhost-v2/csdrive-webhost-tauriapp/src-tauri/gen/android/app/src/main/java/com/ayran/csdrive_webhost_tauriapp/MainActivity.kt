package com.ayran.csdrive_webhost_tauriapp

import android.content.res.Configuration
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  // "top,right,bottom,left" in CSS pixels — what the pages publish as CSS variables.
  @Volatile private var safeArea = "0,0,0,0"

  private val handler = Handler(Looper.getMainLooper())
  private var splash: View? = null
  private var splashShownAt = 0L

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // The windows of web apps (WindowActivity) reach the backend through this (see WindowBridge).
    WindowBridge.init(applicationContext)
    showSplash()
  }

  override fun onResume() {
    super.onResume()
    FolderPicker.onResume(this)
  }

  @Deprecated("Deprecated in Java")
  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    FolderPicker.onPermissionsResult(this, requestCode)
  }

  override fun onDestroy() {
    handler.removeCallbacksAndMessages(null)
    super.onDestroy()
  }

  /**
   * A spinner over the whole window from the moment the activity exists until the admin-app
   * says its first screen is ready (`CsdriveSplash.hide()`, see `nativeSplash.ts`). Until then
   * there is nothing web-side to show: the WebView is only created once the Rust side has
   * started, and only then can it load a page. It hangs off the window's decor view because the
   * WebView is later installed with `setContentView`, which would throw away anything added to
   * the content area. Colours match the app's (`--bg`, `--accent`, `--border` in App.css), light
   * and dark, so the hand-over to the page's own spinner is not noticeable.
   */
  private fun showSplash() {
    val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    val density = resources.displayMetrics.density

    val spinner = SplashSpinnerView(
      this,
      accent = if (night) 0xFFFB923C.toInt() else 0xFFD04A0B.toInt(),
      track = if (night) 0xFF30343C.toInt() else 0xFFE2E8F0.toInt(),
      sizePx = (36 * density).toInt(),
      strokePx = 3 * density,
    )
    val overlay = FrameLayout(this).apply {
      setBackgroundColor(if (night) 0xFF16181D.toInt() else 0xFFFFFFFF.toInt())
      isClickable = true // touches must not reach the page that is still loading underneath
      addView(spinner, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
    }
    (window.decorView as ViewGroup).addView(
      overlay,
      ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )
    splash = overlay
    splashShownAt = SystemClock.uptimeMillis()
    Log.i(TAG, "loading spinner shown")

    // Never leave the app covered: if the page never reports in (it failed to load), show it anyway.
    handler.postDelayed({ hideSplash() }, SPLASH_TIMEOUT_MS)
  }

  private fun hideSplash() {
    val overlay = splash ?: return
    splash = null
    Log.i(TAG, "loading spinner hidden after ${SystemClock.uptimeMillis() - splashShownAt} ms")
    overlay.animate().alpha(0f).setDuration(150).withEndAction {
      (overlay.parent as? ViewGroup)?.removeView(overlay)
    }.start()
  }

  /**
   * The app draws edge to edge, so the pages must keep clear of the system bars
   * themselves. Android's WebView reports 0 for the bottom `env(safe-area-inset-*)`,
   * so the real insets (system bars + camera cutout) are measured here and handed to
   * the pages: pulled by the init script at document start (`CsdriveSafeArea.get()`)
   * and pushed whenever they change (rotation, bars hidden for full screen, ...).
   * They're 0 while the system bars are hidden, so a full-screen page gets the whole
   * screen. See `code_snippets.rs` on the Rust side for the CSS that uses them.
   */
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)

    webView.addJavascriptInterface(SafeAreaBridge(), "CsdriveSafeArea")
    webView.addJavascriptInterface(SplashBridge(), "CsdriveSplash")

    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val density = resources.displayMetrics.density
      val top = bars.top / density
      val right = bars.right / density
      val bottom = bars.bottom / density
      val left = bars.left / density

      safeArea = "$top,$right,$bottom,$left"
      webView.evaluateJavascript(
        "window.__csdriveApplySafeArea && window.__csdriveApplySafeArea($top, $right, $bottom, $left)",
        null
      )
      // Leave the insets to the WebView's default handling too.
      ViewCompat.onApplyWindowInsets(view, insets)
    }
    ViewCompat.requestApplyInsets(webView)
  }

  inner class SafeAreaBridge {
    @JavascriptInterface
    fun get(): String = safeArea
  }

  inner class SplashBridge {
    @JavascriptInterface
    fun hide() {
      runOnUiThread { hideSplash() }
    }
  }

  private companion object {
    const val SPLASH_TIMEOUT_MS = 10_000L
    const val TAG = "CsdriveSplash"
  }
}
