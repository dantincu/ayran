package com.ayran.mobilebatterylogger.filen

import kotlinx.serialization.json.*
import java.security.MessageDigest
import java.util.UUID
import java.util.Date
import java.text.SimpleDateFormat
import java.util.Locale

data class BatteryLogEntry(val dateRead: String, val batteryLevelPercent: Int)

data class FilenFolderNode(
    val uuid: String,
    val name: String,
    val children: MutableList<FilenFolderNode> = mutableListOf(),
    val files: MutableList<FilenDirItem> = mutableListOf()
)

class FilenRepository(
    private val api: FilenApi = FilenApi()
) {

    private val json = Json { ignoreUnknownKeys = true; prettyPrint = true }

    fun authenticate(email: String, password: String, twoFactorCode: String = ""): Triple<String, List<String>, String> {
        val (salt, authVersion) = api.getAuthInfo(email)
        val (authKey, masterKeyHex) = if (authVersion == 1) {
            FilenCrypto.deriveKeysV1(password)
        } else {
            FilenCrypto.deriveKeys(password, salt)
        }
        val (apiKey, encryptedMasterKeys) = api.login(email, authKey, authVersion, twoFactorCode)
        val masterKeys = decryptMasterKeys(encryptedMasterKeys, masterKeyHex)
        return Triple(apiKey, masterKeys, email)
    }

    fun validateApiKeyOnly(apiKey: String): Boolean = api.validateApiKey(apiKey)

    private fun decryptMasterKeys(encrypted: String, masterKey: String): List<String> {
        return try {
            val decrypted = FilenCrypto.decryptMetadata(encrypted, masterKey)
            val parsed = json.parseToJsonElement(decrypted)
            when {
                parsed is JsonArray -> parsed.map { it.jsonPrimitive.content }
                parsed is JsonObject -> {
                    val keys = parsed["keys"]?.jsonArray?.map { it.jsonPrimitive.content }
                    keys ?: listOf(masterKey)
                }
                else -> listOf(masterKey)
            }
        } catch (_: Exception) {
            listOf(masterKey)
        }
    }

    fun listDirectory(apiKey: String, masterKeys: List<String>, uuid: String): Pair<List<FilenDirItem>, List<FilenDirItem>> {
        val (folders, files) = api.getDirContent(apiKey, uuid)

        val decryptedFolders = folders.map { folder ->
            val decryptedName = tryDecryptName(folder.name, masterKeys) ?: folder.name
            folder.copy(nameDecrypted = decryptedName)
        }

        val decryptedFiles = files.map { file ->
            val meta = tryDecryptFileMetadata(file.name, masterKeys)
            file.copy(nameDecrypted = meta?.name ?: file.name)
        }

        return Pair(decryptedFolders, decryptedFiles)
    }

    fun getRootFolderUuid(apiKey: String): String = api.getUserRootFolderUuid(apiKey)

    private fun tryDecryptName(encrypted: String, masterKeys: List<String>): String? {
        for (key in masterKeys.reversed()) {
            try {
                return FilenCrypto.decryptMetadata(encrypted, key)
            } catch (_: Exception) {}
        }
        return null
    }

    private fun tryDecryptFileMetadata(encrypted: String, masterKeys: List<String>): FilenFileMetadata? {
        for (key in masterKeys.reversed()) {
            try {
                val decrypted = FilenCrypto.decryptMetadata(encrypted, key)
                val obj = json.parseToJsonElement(decrypted).jsonObject
                return FilenFileMetadata(
                    name = obj["name"]?.jsonPrimitive?.contentOrNull ?: "",
                    size = obj["size"]?.jsonPrimitive?.longOrNull ?: 0,
                    mime = obj["mime"]?.jsonPrimitive?.contentOrNull ?: "",
                    key = obj["key"]?.jsonPrimitive?.contentOrNull ?: "",
                    lastModified = obj["lastModified"]?.jsonPrimitive?.longOrNull ?: 0
                )
            } catch (_: Exception) {}
        }
        return null
    }

    fun readJsonLogFile(apiKey: String, masterKeys: List<String>, fileUuid: String): JsonObject? {
        return try {
            val fileInfo = api.getFileInfo(apiKey, fileUuid)
            val metadataEncrypted = fileInfo["metadata"]?.jsonPrimitive?.content ?: return null
            val bucket = fileInfo["bucket"]?.jsonPrimitive?.content ?: return null
            val region = fileInfo["region"]?.jsonPrimitive?.content ?: return null
            val version = fileInfo["version"]?.jsonPrimitive?.intOrNull ?: 2

            val meta = tryDecryptFileMetadata(metadataEncrypted, masterKeys) ?: return null
            val chunkData = api.downloadFileChunk(apiKey, fileUuid, bucket, region, 0)
            val decrypted = FilenCrypto.decryptFileContent(chunkData, meta.key, "", version)
            val text = decrypted.toString(Charsets.UTF_8)
            json.parseToJsonElement(text).jsonObject
        } catch (_: Exception) {
            null
        }
    }

    fun writeJsonLogFile(
        apiKey: String,
        masterKeys: List<String>,
        parentUuid: String,
        existingFileUuid: String?,
        fileName: String,
        logObject: JsonObject
    ): String {
        val masterKey = masterKeys.last()

        val content = json.encodeToString(JsonObject.serializer(), logObject).toByteArray(Charsets.UTF_8)
        val (encrypted, fileKey, _) = FilenCrypto.encryptFileContent(content)

        val metaObj = buildJsonObject {
            put("name", fileName)
            put("size", content.size.toLong())
            put("mime", "application/json")
            put("key", fileKey)
            put("lastModified", System.currentTimeMillis())
        }
        val metaStr = metaObj.toString()
        val metaEncrypted = FilenCrypto.encryptMetadata(metaStr, masterKey)
        val nameEncrypted = FilenCrypto.encryptMetadata(fileName, masterKey)
        val nameHashed = sha512(fileName.lowercase())
        val sizeEncrypted = FilenCrypto.encryptMetadata(content.size.toString(), masterKey)
        val mimeEncrypted = FilenCrypto.encryptMetadata("application/json", masterKey)

        val newUuid = UUID.randomUUID().toString()
        val uploadKey = UUID.randomUUID().toString().replace("-", "")

        val result = api.uploadFileChunk(apiKey, newUuid, 0, parentUuid, uploadKey, encrypted)
        api.markUploadDone(
            apiKey, newUuid, nameEncrypted, nameHashed,
            sizeEncrypted, mimeEncrypted, metaEncrypted, 2, uploadKey
        )

        if (existingFileUuid != null && existingFileUuid.isNotEmpty()) {
            try { api.trashFile(apiKey, existingFileUuid) } catch (_: Exception) {}
        }

        return newUuid
    }

    fun logBattery(
        apiKey: String,
        masterKeys: List<String>,
        fileUuid: String,
        parentUuid: String,
        fileName: String,
        batteryLevel: Int,
        maxEntries: Int
    ): String {
        val existing = if (fileUuid.isNotEmpty()) {
            readJsonLogFile(apiKey, masterKeys, fileUuid)
        } else null

        val existingLogs = existing?.get("logs")?.jsonArray?.toMutableList()
            ?: mutableListOf()

        val formatter = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault())
        val newEntry = buildJsonObject {
            put("dateRead", formatter.format(Date()))
            put("batteryLevelPercent", batteryLevel)
        }

        val updatedLogs = buildJsonArray {
            add(newEntry)
            existingLogs.take(maxEntries - 1).forEach { add(it) }
        }

        val logObject = buildJsonObject { put("logs", updatedLogs) }
        return writeJsonLogFile(apiKey, masterKeys, parentUuid, fileUuid, fileName, logObject)
    }

    private fun sha512(input: String): String {
        val digest = MessageDigest.getInstance("SHA-512")
        val bytes = digest.digest(input.toByteArray(Charsets.UTF_8))
        return bytes.joinToString("") { "%02x".format(it) }
    }
}
