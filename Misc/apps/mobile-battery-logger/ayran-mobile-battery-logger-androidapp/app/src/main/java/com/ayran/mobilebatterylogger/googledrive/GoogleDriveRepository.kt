package com.ayran.mobilebatterylogger.googledrive

import com.ayran.mobilebatterylogger.filen.FilenDirItem
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.TimeUnit

class GoogleDriveRepository {

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    private val json = Json { ignoreUnknownKeys = true }
    private val baseUrl = "https://www.googleapis.com/drive/v3"
    private val uploadUrl = "https://www.googleapis.com/upload/drive/v3"

    private fun bearer(token: String) = "Bearer $token"

    fun listFolder(accessToken: String, folderId: String): Pair<List<FilenDirItem>, List<FilenDirItem>> {
        val q = URLEncoder.encode("'$folderId' in parents and trashed = false", "UTF-8")
        val url = "$baseUrl/files?q=$q&fields=files(id,name,mimeType)&pageSize=200&orderBy=name"
        val response = client.newCall(
            Request.Builder().url(url).header("Authorization", bearer(accessToken)).get().build()
        ).execute()
        val body = response.body?.string() ?: throw Exception("Empty Drive list response")
        val files = json.parseToJsonElement(body).jsonObject["files"]?.jsonArray
            ?: return Pair(emptyList(), emptyList())

        val folders = mutableListOf<FilenDirItem>()
        val docs = mutableListOf<FilenDirItem>()
        for (file in files) {
            val obj = file.jsonObject
            val id = obj["id"]?.jsonPrimitive?.content ?: continue
            val name = obj["name"]?.jsonPrimitive?.content ?: continue
            val isFolder = obj["mimeType"]?.jsonPrimitive?.content == "application/vnd.google-apps.folder"
            val item = FilenDirItem(uuid = id, name = name, nameDecrypted = name, isFolder = isFolder, parent = folderId)
            if (isFolder) folders.add(item) else docs.add(item)
        }
        return Pair(folders, docs)
    }

    fun readJsonFile(accessToken: String, fileId: String): JsonObject? {
        return try {
            val response = client.newCall(
                Request.Builder().url("$baseUrl/files/$fileId?alt=media")
                    .header("Authorization", bearer(accessToken)).get().build()
            ).execute()
            val text = response.body?.string() ?: return null
            json.parseToJsonElement(text).jsonObject
        } catch (_: Exception) { null }
    }

    fun writeJsonFile(
        accessToken: String,
        parentId: String,
        existingFileId: String?,
        fileName: String,
        content: ByteArray
    ): String = if (existingFileId.isNullOrEmpty()) {
        createFile(accessToken, parentId, fileName, content)
    } else {
        updateFile(accessToken, existingFileId, content)
    }

    private fun createFile(accessToken: String, parentId: String, fileName: String, content: ByteArray): String {
        val boundary = "boundary_${System.currentTimeMillis()}"
        val meta = """{"name":"$fileName","parents":["$parentId"]}"""
        val body = buildMultipart(boundary, meta, content)
        val response = client.newCall(
            Request.Builder()
                .url("$uploadUrl/files?uploadType=multipart&fields=id")
                .header("Authorization", bearer(accessToken))
                .post(body.toRequestBody("multipart/related; boundary=$boundary".toMediaType()))
                .build()
        ).execute()
        val text = response.body?.string() ?: throw Exception("Empty create response")
        return json.parseToJsonElement(text).jsonObject["id"]?.jsonPrimitive?.content
            ?: throw Exception("No file id in create response")
    }

    private fun updateFile(accessToken: String, fileId: String, content: ByteArray): String {
        val response = client.newCall(
            Request.Builder()
                .url("$uploadUrl/files/$fileId?uploadType=media")
                .header("Authorization", bearer(accessToken))
                .method("PATCH", content.toRequestBody("application/json".toMediaType()))
                .build()
        ).execute()
        if (!response.isSuccessful) throw Exception("Drive update failed: ${response.code}")
        return fileId
    }

    private fun buildMultipart(boundary: String, metaJson: String, content: ByteArray): ByteArray {
        val pre = "--$boundary\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n$metaJson\r\n" +
                "--$boundary\r\nContent-Type: application/json\r\n\r\n"
        val suf = "\r\n--$boundary--"
        return pre.toByteArray(Charsets.UTF_8) + content + suf.toByteArray(Charsets.UTF_8)
    }

    fun logBattery(
        accessToken: String,
        fileId: String,
        parentId: String,
        fileName: String,
        batteryLevel: Int,
        maxEntries: Int
    ): String {
        val jsonFmt = Json { prettyPrint = true }
        val existing = if (fileId.isNotEmpty()) readJsonFile(accessToken, fileId) else null
        val existingLogs = existing?.get("logs")?.jsonArray?.toMutableList() ?: mutableListOf()
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
        val content = jsonFmt.encodeToString(JsonObject.serializer(), logObject).toByteArray(Charsets.UTF_8)
        return writeJsonFile(accessToken, parentId, fileId.ifEmpty { null }, fileName, content)
    }
}
