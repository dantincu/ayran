package io.ayran.lanstreamer.mobile

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
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
}
