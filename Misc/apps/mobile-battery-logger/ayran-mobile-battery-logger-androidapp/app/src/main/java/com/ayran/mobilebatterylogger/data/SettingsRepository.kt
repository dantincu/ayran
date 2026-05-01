package com.ayran.mobilebatterylogger.data

import android.content.Context
import androidx.security.crypto.EncryptedFile
import androidx.security.crypto.MasterKey
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File

class SettingsRepository(private val context: Context) {

    private val masterKey: MasterKey by lazy {
        MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
    }

    private val settingsFileName = "app_settings.json"

    private fun encryptedFile(): EncryptedFile = EncryptedFile.Builder(
        context,
        File(context.filesDir, settingsFileName),
        masterKey,
        EncryptedFile.FileEncryptionScheme.AES256_GCM_HKDF_4KB
    ).build()

    fun load(): AppSettings {
        val file = File(context.filesDir, settingsFileName)
        if (!file.exists()) return AppSettings()
        return try {
            encryptedFile().openFileInput().use { stream ->
                Json.decodeFromString(stream.readBytes().toString(Charsets.UTF_8))
            }
        } catch (_: Exception) {
            AppSettings()
        }
    }

    fun save(settings: AppSettings) {
        // EncryptedFile cannot overwrite — delete first, then write
        File(context.filesDir, settingsFileName).delete()
        encryptedFile().openFileOutput().use { stream ->
            stream.write(Json.encodeToString(settings).toByteArray(Charsets.UTF_8))
        }
    }

    fun clear() {
        File(context.filesDir, settingsFileName).delete()
    }
}
