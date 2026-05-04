package com.ayran.mobilebatterylogger.storage

data class StorageProvider(val id: String, val displayName: String, val enabled: Boolean)

object StorageProviderConfig {
    val providers = listOf(
        StorageProvider(id = "filen", displayName = "Filen.io", enabled = false),
        StorageProvider(id = "google_drive", displayName = "Google Drive", enabled = true)
    )
    val enabledProviders = providers.filter { it.enabled }
}
