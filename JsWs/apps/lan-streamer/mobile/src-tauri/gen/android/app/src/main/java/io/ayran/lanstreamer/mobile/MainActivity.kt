package io.ayran.lanstreamer.mobile

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import io.crates.keyring.Keyring

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Seeds the ndk-context crate's global Android context, which the
    // android-native-keyring-store backend (used for OS-native session
    // storage) needs before it can be used - see src/session.rs.
    Keyring.initializeNdkContext(applicationContext)

    // The ongoing notification StreamingForegroundService shows while
    // hosting/listening in the background needs this runtime permission on
    // Android 13+ - without it the foreground service still works (Android
    // just can't show the notification), so this is a best-effort ask, not
    // something that has to succeed before streaming can start.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
        ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 0)
      }
    }
  }

  // WryActivity's own onPause() (generated, do not modify) unconditionally
  // calls WebView.onPause(), which suspends JS timers/processing - this
  // silently breaks active mic capture (ScriptProcessorNode) even though
  // StreamingForegroundService already keeps the *process* itself alive in
  // the background. mWebView there is private, so rather than fight the
  // inheritance chain, just immediately undo the pause via the public
  // WebView.onResume() API whenever a stream is actually active.
  override fun onPause() {
    super.onPause()
    if (StreamingForegroundService.isActive) {
      findWebView(window.decorView)?.onResume()
    }
  }

  private fun findWebView(view: View): WebView? {
    if (view is WebView) return view
    if (view is ViewGroup) {
      for (i in 0 until view.childCount) {
        val found = findWebView(view.getChildAt(i))
        if (found != null) return found
      }
    }
    return null
  }
}
