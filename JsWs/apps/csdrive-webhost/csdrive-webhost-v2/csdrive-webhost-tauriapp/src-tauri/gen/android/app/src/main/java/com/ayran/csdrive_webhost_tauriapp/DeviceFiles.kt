package com.ayran.csdrive_webhost_tauriapp

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import java.io.IOException

/**
 * Puts a file into the device's public Downloads folder (see `device_files.rs`).
 *
 * Goes through MediaStore, which needs no storage permission from Android 10 on. Rust
 * calls [saveToDownloads] over JNI; failures come back as "!<message>" rather than as
 * exceptions, so the message reaches the user intact.
 */
object DeviceFiles {
  @JvmStatic
  fun saveToDownloads(context: Context, name: String, data: ByteArray): String {
    return try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
        throw IOException("Saving to Downloads needs Android 10 or newer.")
      }
      val resolver = context.contentResolver
      val extension = MimeTypeMap.getFileExtensionFromUrl(name.replace(" ", "_"))
      val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension.lowercase()) ?: "application/octet-stream"

      val values = ContentValues().apply {
        put(MediaStore.Downloads.DISPLAY_NAME, name)
        put(MediaStore.Downloads.MIME_TYPE, mime)
        put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
        put(MediaStore.Downloads.IS_PENDING, 1)
      }
      val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        ?: throw IOException("Android refused to create the file.")

      try {
        resolver.openOutputStream(uri)?.use { it.write(data) } ?: throw IOException("Couldn't open the new file.")
        values.clear()
        values.put(MediaStore.Downloads.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
      } catch (e: Exception) {
        resolver.delete(uri, null, null)
        throw e
      }

      // MediaStore renames on a collision ("name (1).ext"), so report what it really used.
      val saved = resolver.query(uri, arrayOf(MediaStore.Downloads.DISPLAY_NAME), null, null, null)?.use {
        if (it.moveToFirst()) it.getString(0) else null
      } ?: name
      "${Environment.DIRECTORY_DOWNLOADS}/$saved"
    } catch (e: Exception) {
      "!" + (e.message ?: e.javaClass.simpleName)
    }
  }
}
