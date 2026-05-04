package com.ayran.mobilebatterylogger.data

import kotlinx.serialization.Serializable

@Serializable
data class AppSettings(
    val selectedProvider: String = "",
    val fileUuid: String = "",
    val filePath: String = "",
    val parentFolderUuid: String = "",
    val maxLogEntries: Int = 10,
    val apiKey: String = "",
    val masterKeys: List<String> = emptyList(),
    val email: String = ""
)
