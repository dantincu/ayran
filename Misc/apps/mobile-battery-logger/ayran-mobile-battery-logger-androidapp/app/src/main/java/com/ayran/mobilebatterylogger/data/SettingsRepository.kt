package com.ayran.mobilebatterylogger.data

import android.content.Context
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File

class SettingsRepository(private val context: Context) {

    private val settingsFile: File
        get() = File(context.filesDir, "app_settings.json")

    fun load(): AppSettings {
        return try {
            if (settingsFile.exists()) {
                Json.decodeFromString(settingsFile.readText())
            } else {
                AppSettings()
            }
        } catch (_: Exception) {
            AppSettings()
        }
    }

    fun save(settings: AppSettings) {
        settingsFile.writeText(Json.encodeToString(settings))
    }

    fun clear() {
        settingsFile.delete()
    }
}
