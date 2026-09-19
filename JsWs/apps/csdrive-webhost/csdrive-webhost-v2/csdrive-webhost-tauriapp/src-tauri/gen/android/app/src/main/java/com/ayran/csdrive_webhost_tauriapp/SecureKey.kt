package com.ayran.csdrive_webhost_tauriapp

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The app's one encryption key (see `secure_store.rs`), protected by the Android Keystore.
 *
 * A random 32-byte key is generated the first time it's asked for. It's stored only in
 * *wrapped* form — AES-GCM encrypted by a key that lives in the Keystore (hardware-backed
 * where the device has it) and can never be exported — in the app's private preferences.
 * Rust calls [getOrCreateAppKey] over JNI.
 */
object SecureKey {
  private const val TAG = "CsdriveSecureKey"
  private const val KEYSTORE = "AndroidKeyStore"
  private const val WRAP_KEY_ALIAS = "csdrive_app_key_wrapper"
  private const val PREFS = "csdrive_secure_store"
  private const val PREF_WRAPPED_KEY = "wrapped_app_key"
  private const val GCM_TAG_BITS = 128
  private const val APP_KEY_BYTES = 32
  private const val GCM_IV_BYTES = 12

  @JvmStatic
  @Synchronized
  fun getOrCreateAppKey(context: Context): ByteArray {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val wrapKey = getOrCreateWrapKey()

    prefs.getString(PREF_WRAPPED_KEY, null)?.let { stored ->
      try {
        return unwrap(wrapKey, Base64.decode(stored, Base64.NO_WRAP))
      } catch (e: Exception) {
        // The Keystore key is gone or doesn't match (app data restored onto another
        // device, Keystore reset, ...). What was encrypted with the old key is
        // unrecoverable either way, so start over rather than leave the app stuck.
        Log.w(TAG, "Stored app key can't be unwrapped; generating a new one", e)
      }
    }

    val appKey = ByteArray(APP_KEY_BYTES).also { SecureRandom().nextBytes(it) }
    prefs.edit().putString(PREF_WRAPPED_KEY, Base64.encodeToString(wrap(wrapKey, appKey), Base64.NO_WRAP)).commit()
    return appKey
  }

  private fun getOrCreateWrapKey(): SecretKey {
    val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    (keyStore.getKey(WRAP_KEY_ALIAS, null) as? SecretKey)?.let { return it }

    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    generator.init(
      KeyGenParameterSpec.Builder(
        WRAP_KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return generator.generateKey()
  }

  /** iv || ciphertext+tag */
  private fun wrap(wrapKey: SecretKey, plain: ByteArray): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, wrapKey)
    return cipher.iv + cipher.doFinal(plain)
  }

  private fun unwrap(wrapKey: SecretKey, wrapped: ByteArray): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(
      Cipher.DECRYPT_MODE,
      wrapKey,
      GCMParameterSpec(GCM_TAG_BITS, wrapped, 0, GCM_IV_BYTES)
    )
    val plain = cipher.doFinal(wrapped, GCM_IV_BYTES, wrapped.size - GCM_IV_BYTES)
    check(plain.size == APP_KEY_BYTES) { "unwrapped key has the wrong length" }
    return plain
  }
}
