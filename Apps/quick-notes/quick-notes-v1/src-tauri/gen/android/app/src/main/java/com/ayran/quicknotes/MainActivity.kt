package com.ayran.quicknotes

import android.os.Bundle
import android.util.Log
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
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
}
