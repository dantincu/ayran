package com.ayran.csdrive_webhost_tauriapp

import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  // "top,right,bottom,left" in CSS pixels — what the pages publish as CSS variables.
  @Volatile private var safeArea = "0,0,0,0"

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
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
}
