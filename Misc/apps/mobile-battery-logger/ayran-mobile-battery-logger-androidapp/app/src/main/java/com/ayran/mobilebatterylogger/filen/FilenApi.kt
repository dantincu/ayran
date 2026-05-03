package com.ayran.mobilebatterylogger.filen

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

@Serializable
data class FilenDirItem(
    val uuid: String,
    val name: String,
    val nameDecrypted: String = "",
    val isFolder: Boolean = false,
    val parent: String = ""
)

@Serializable
data class FilenFileMetadata(
    val name: String = "",
    val size: Long = 0,
    val mime: String = "",
    val key: String = "",
    val lastModified: Long = 0
)

class FilenApi {

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    private val json = Json { ignoreUnknownKeys = true }
    private val mediaType = "application/json; charset=utf-8".toMediaType()
    private val baseUrl = "https://gateway.filen.io"

    private fun post(endpoint: String, body: JsonObject, apiKey: String? = null): JsonObject {
        val builder = Request.Builder()
            .url("$baseUrl$endpoint")
            .post(body.toString().toRequestBody(mediaType))
        if (apiKey != null) builder.header("Authorization", "Bearer $apiKey")
        val response = client.newCall(builder.build()).execute()
        val responseText = response.body?.string() ?: throw Exception("Empty response from $endpoint")
        val parsed = json.parseToJsonElement(responseText) as? JsonObject
            ?: throw Exception("Invalid JSON from $endpoint")
        val statusContent = (parsed["status"] as? JsonPrimitive)?.content ?: ""
        val status = statusContent == "true" || statusContent == "ok"
        if (!status) {
            val msg = (parsed["message"] as? JsonPrimitive)?.content ?: "Unknown API error"
            throw Exception("Filen API error ($endpoint): $msg")
        }
        return parsed["data"] as? JsonObject ?: JsonObject(emptyMap())
    }

    private fun get(endpoint: String, apiKey: String): JsonObject {
        val request = Request.Builder()
            .url("$baseUrl$endpoint")
            .header("Authorization", "Bearer $apiKey")
            .get()
            .build()
        val response = client.newCall(request).execute()
        val responseText = response.body?.string() ?: throw Exception("Empty response from $endpoint")
        val parsed = json.parseToJsonElement(responseText) as? JsonObject
            ?: throw Exception("Invalid JSON from $endpoint")
        val statusContent = (parsed["status"] as? JsonPrimitive)?.content ?: ""
        val status = statusContent == "true" || statusContent == "ok"
        if (!status) {
            val msg = (parsed["message"] as? JsonPrimitive)?.content ?: "Unknown API error"
            throw Exception("Filen API error ($endpoint): $msg")
        }
        return parsed["data"] as? JsonObject ?: JsonObject(emptyMap())
    }

    fun getAuthInfo(email: String): Pair<String, Int> {
        val data = post("/v3/auth/info", buildJsonObject { put("email", email) })
        val salt = data["salt"]?.jsonPrimitive?.content ?: throw Exception("No salt in auth info")
        val authVersion = data["authVersion"]?.jsonPrimitive?.intOrNull ?: 2
        return Pair(salt, authVersion)
    }

    fun login(email: String, password: String, authVersion: Int, twoFactorCode: String): Pair<String, String> {
        val data = post("/v3/login", buildJsonObject {
            put("email", email)
            put("password", password)
            put("authVersion", authVersion)
            put("twoFactorCode", twoFactorCode.ifBlank { "XXXXXX" })
        })
        val apiKey = data["apiKey"]?.jsonPrimitive?.content ?: throw Exception("No apiKey in login response")
        val masterKeys = data["masterKeys"]?.jsonPrimitive?.content ?: ""
        return Pair(apiKey, masterKeys)
    }

    fun validateApiKey(apiKey: String): Boolean {
        return try {
            get("/v3/user/info", apiKey)
            true
        } catch (_: Exception) {
            false
        }
    }

    fun getUserRootFolderUuid(apiKey: String): String {
        val data = get("/v3/user/baseFolder", apiKey)
        return (data["uuid"] as? JsonPrimitive)?.content
            ?: throw Exception("No base folder UUID in user/baseFolder response")
    }

    fun getDirContent(apiKey: String, uuid: String): Pair<List<FilenDirItem>, List<FilenDirItem>> {
        val data = post("/v3/dir/content", buildJsonObject { put("uuid", uuid) }, apiKey)
        val folders = data["folders"]?.jsonArray?.map { el ->
            val obj = el.jsonObject
            FilenDirItem(
                uuid = obj["uuid"]?.jsonPrimitive?.content ?: "",
                name = obj["name"]?.jsonPrimitive?.content ?: "",
                isFolder = true,
                parent = obj["parent"]?.jsonPrimitive?.content ?: ""
            )
        } ?: emptyList()

        val files = data["uploads"]?.jsonArray?.map { el ->
            val obj = el.jsonObject
            FilenDirItem(
                uuid = obj["uuid"]?.jsonPrimitive?.content ?: "",
                name = obj["metadata"]?.jsonPrimitive?.content ?: "",
                isFolder = false,
                parent = obj["parent"]?.jsonPrimitive?.content ?: ""
            )
        } ?: emptyList()

        return Pair(folders, files)
    }

    fun downloadFileChunk(apiKey: String, uuid: String, bucket: String, region: String, index: Int): ByteArray {
        val url = "https://$region.storage.filen.io/$bucket/$uuid/$index"
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $apiKey")
            .get()
            .build()
        val response = client.newCall(request).execute()
        return response.body?.bytes() ?: throw Exception("Empty chunk response")
    }

    fun getFileInfo(apiKey: String, uuid: String): JsonObject {
        return post("/v3/file", buildJsonObject { put("uuid", uuid) }, apiKey)
    }

    data class UploadResult(val uuid: String, val bucket: String, val region: String)

    fun uploadFileChunk(
        apiKey: String,
        uuid: String,
        index: Int,
        parentUuid: String,
        uploadKey: String,
        chunkData: ByteArray
    ): UploadResult {
        val url = "$baseUrl/v3/upload?uuid=$uuid&index=$index&parent=$parentUuid&uploadKey=$uploadKey"
        val body = chunkData.toRequestBody("application/octet-stream".toMediaType())
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $apiKey")
            .post(body)
            .build()
        val response = client.newCall(request).execute()
        val text = response.body?.string() ?: throw Exception("Empty upload response")
        val parsed = json.parseToJsonElement(text).jsonObject
        val data = parsed["data"]?.jsonObject ?: JsonObject(emptyMap())
        return UploadResult(
            uuid = data["uuid"]?.jsonPrimitive?.content ?: uuid,
            bucket = data["bucket"]?.jsonPrimitive?.content ?: "",
            region = data["region"]?.jsonPrimitive?.content ?: ""
        )
    }

    fun markUploadDone(
        apiKey: String,
        uuid: String,
        nameEncrypted: String,
        nameHashed: String,
        sizeEncrypted: String,
        mimeEncrypted: String,
        metadataEncrypted: String,
        version: Int,
        uploadKey: String
    ) {
        post("/v3/upload/done", buildJsonObject {
            put("uuid", uuid)
            put("name", nameEncrypted)
            put("nameHashed", nameHashed)
            put("size", sizeEncrypted)
            put("chunks", 1)
            put("mime", mimeEncrypted)
            put("rm", "")
            put("metadata", metadataEncrypted)
            put("version", version)
            put("uploadKey", uploadKey)
        }, apiKey)
    }

    fun trashFile(apiKey: String, uuid: String) {
        post("/v3/file/trash", buildJsonObject { put("uuid", uuid) }, apiKey)
    }
}
