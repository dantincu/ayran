package io.ayran.lanstreamer.mobile

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import io.crates.keyring.Keyring

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Seeds the ndk-context crate's global Android context, which the
    // android-native-keyring-store backend (used for OS-native session
    // storage) needs before it can be used - see src/session.rs.
    Keyring.initializeNdkContext(applicationContext)
  }
}
