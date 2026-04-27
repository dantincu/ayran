package com.ayran.mobilebatterylogger.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import com.ayran.mobilebatterylogger.data.SettingsRepository
import com.ayran.mobilebatterylogger.filen.FilenRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class TaskerReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != "com.ayran.mobilebatterylogger.LOG_BATTERY") return

        val pendingResult = goAsync()
        val appContext = context.applicationContext

        CoroutineScope(Dispatchers.IO).launch {
            try {
                val repo = SettingsRepository(appContext)
                val settings = repo.load()

                if (settings.apiKey.isEmpty()) {
                    pendingResult.finish()
                    return@launch
                }
                if (settings.fileUuid.isEmpty() && settings.filePath.isEmpty()) {
                    pendingResult.finish()
                    return@launch
                }

                val batteryLevel = getBatteryLevel(appContext)
                if (batteryLevel < 0) {
                    pendingResult.finish()
                    return@launch
                }

                val filenRepo = FilenRepository()
                val fileName = settings.filePath.substringAfterLast("/").let { if (it.isEmpty()) "battery_log.json" else it }
                val parentUuid = if (settings.parentFolderUuid.isNotEmpty()) settings.parentFolderUuid
                                 else filenRepo.getRootFolderUuid(settings.apiKey)

                val newUuid = filenRepo.logBattery(
                    settings.apiKey,
                    settings.masterKeys,
                    settings.fileUuid,
                    parentUuid,
                    fileName,
                    batteryLevel,
                    settings.maxLogEntries
                )

                repo.save(settings.copy(fileUuid = newUuid))
            } catch (_: Exception) {
            } finally {
                pendingResult.finish()
            }
        }
    }

    private fun getBatteryLevel(context: Context): Int {
        val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        return if (level >= 0 && scale > 0) (level * 100 / scale) else -1
    }
}
