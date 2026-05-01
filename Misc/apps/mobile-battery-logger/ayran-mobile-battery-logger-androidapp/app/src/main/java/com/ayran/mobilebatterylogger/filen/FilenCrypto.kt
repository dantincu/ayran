package com.ayran.mobilebatterylogger.filen

import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import javax.crypto.Cipher
import java.security.MessageDigest
import java.security.SecureRandom
import android.util.Base64

object FilenCrypto {

    fun sha512(input: String): String {
        val digest = MessageDigest.getInstance("SHA-512")
        return digest.digest(input.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    // Auth version 1: SHA512(SHA512(password) + "filen" + SHA512(password))
    // master key is SHA512(password)
    fun deriveKeysV1(password: String): Pair<String, String> {
        val h = sha512(password)
        val authKey = sha512(h + "filen" + h)
        return Pair(authKey, h)
    }

    // Auth version 2: PBKDF2-SHA512 implemented manually so the password is
    // passed as raw UTF-8 bytes to HMAC, matching Node.js crypto.pbkdf2 exactly.
    fun deriveKeys(password: String, salt: String): Pair<String, String> {
        val passwordBytes = password.toByteArray(Charsets.UTF_8)
        val saltBytes = salt.toByteArray(Charsets.UTF_8)
        val keyBytes = pbkdf2HmacSha512(passwordBytes, saltBytes, iterations = 200000, keyLenBytes = 64)
        val hex = keyBytes.joinToString("") { "%02x".format(it) }
        val masterKey = hex.substring(0, 64)
        val authKey = sha512(hex.substring(64, 128))
        return Pair(authKey, masterKey)
    }

    private fun pbkdf2HmacSha512(password: ByteArray, salt: ByteArray, iterations: Int, keyLenBytes: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA512")
        mac.init(SecretKeySpec(password, "HmacSHA512"))
        val result = ByteArray(keyLenBytes)
        var blockIndex = 1
        var offset = 0
        while (offset < keyLenBytes) {
            val block = pbkdf2Block(mac, salt, iterations, blockIndex++)
            val len = minOf(block.size, keyLenBytes - offset)
            block.copyInto(result, offset, 0, len)
            offset += len
        }
        return result
    }

    private fun pbkdf2Block(mac: Mac, salt: ByteArray, iterations: Int, index: Int): ByteArray {
        val intBytes = byteArrayOf(
            (index shr 24).toByte(), (index shr 16).toByte(),
            (index shr 8).toByte(), index.toByte()
        )
        mac.update(salt)
        mac.update(intBytes)
        var u = mac.doFinal()
        val t = u.copyOf()
        repeat(iterations - 1) {
            u = mac.doFinal(u)
            for (j in t.indices) t[j] = (t[j].toInt() xor u[j].toInt()).toByte()
        }
        return t
    }

    fun decryptMetadata(encrypted: String, key: String): String {
        return try {
            when {
                encrypted.startsWith("002") -> decryptMetadataV2(encrypted.substring(3), key)
                else -> decryptMetadataV1(encrypted, key)
            }
        } catch (e: Exception) {
            throw IllegalArgumentException("Failed to decrypt metadata: ${e.message}", e)
        }
    }

    private fun decryptMetadataV2(data: String, key: String): String {
        val raw = Base64.decode(data, Base64.NO_WRAP)
        // Format: iv(12 bytes) + ciphertext+tag
        val iv = raw.copyOfRange(0, 12)
        val ciphertext = raw.copyOfRange(12, raw.size)
        val keyBytes = hexToBytes(key)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(keyBytes, "AES"), GCMParameterSpec(128, iv))
        return cipher.doFinal(ciphertext).toString(Charsets.UTF_8)
    }

    private fun decryptMetadataV1(data: String, key: String): String {
        // v1 uses AES-CBC
        val parts = data.split("|")
        if (parts.size < 2) throw IllegalArgumentException("Invalid v1 metadata format")
        val iv = parts[0].toByteArray(Charsets.UTF_8).copyOf(16)
        val ciphertext = Base64.decode(parts[1], Base64.NO_WRAP)
        val keyBytes = key.toByteArray(Charsets.UTF_8).copyOf(32)
        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(keyBytes, "AES"),
            javax.crypto.spec.IvParameterSpec(iv))
        return cipher.doFinal(ciphertext).toString(Charsets.UTF_8)
    }

    fun encryptMetadata(plaintext: String, key: String): String {
        val keyBytes = hexToBytes(key)
        val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(keyBytes, "AES"), GCMParameterSpec(128, iv))
        val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        val combined = iv + ciphertext
        return "002" + Base64.encodeToString(combined, Base64.NO_WRAP)
    }

    fun decryptFileContent(data: ByteArray, key: String, iv: String, version: Int): ByteArray {
        return when (version) {
            1 -> decryptFileV1(data, key, iv)
            else -> decryptFileV2(data, key, iv)
        }
    }

    private fun decryptFileV1(data: ByteArray, key: String, iv: String): ByteArray {
        val keyBytes = key.toByteArray(Charsets.UTF_8).copyOf(32)
        val ivBytes = iv.toByteArray(Charsets.UTF_8).copyOf(16)
        val cipher = Cipher.getInstance("AES/CTR/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(keyBytes, "AES"),
            javax.crypto.spec.IvParameterSpec(ivBytes))
        return cipher.doFinal(data)
    }

    private fun decryptFileV2(data: ByteArray, key: String, iv: String): ByteArray {
        val keyBytes = hexToBytes(key)
        val ivBytes = hexToBytes(iv)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(keyBytes, "AES"),
            GCMParameterSpec(128, ivBytes))
        return cipher.doFinal(data)
    }

    fun encryptFileContent(data: ByteArray): Triple<ByteArray, String, String> {
        val keyBytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val ivBytes = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val keyHex = bytesToHex(keyBytes)
        val ivHex = bytesToHex(ivBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(keyBytes, "AES"), GCMParameterSpec(128, ivBytes))
        val encrypted = cipher.doFinal(data)
        return Triple(encrypted, keyHex, ivHex)
    }

    private fun hexToBytes(hex: String): ByteArray {
        check(hex.length % 2 == 0) { "Odd hex string length" }
        return ByteArray(hex.length / 2) { i ->
            hex.substring(i * 2, i * 2 + 2).toInt(16).toByte()
        }
    }

    private fun bytesToHex(bytes: ByteArray): String =
        bytes.joinToString("") { "%02x".format(it) }
}
