package com.ayran.mobilebatterylogger.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import com.ayran.mobilebatterylogger.data.SettingsRepository
import com.ayran.mobilebatterylogger.filen.FilenRepository
import com.ayran.mobilebatterylogger.googledrive.GoogleDriveRepository
import com.google.android.gms.auth.GoogleAuthUtil
import com.google.android.gms.auth.api.signin.GoogleSignIn
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class TaskerReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != "com.ayran.mobilebatterylogger.LOG_BATTERY") return

        val pendingResult = goAsync()
        val appContext = context.applicationContext

        CoroutineScope(Dispatchers.IO).launch {
            try {
                val repo = SettingsRepository(appContext)
                val settings = repo.load()

                if (settings.filePath.isEmpty()) {
                    pendingResult.finish()
                    return@launch
                }

                val batteryLevel = getBatteryLevel(appContext)
                if (batteryLevel < 0) {
                    pendingResult.finish()
                    return@launch
                }

                val fileName = settings.filePath.substringAfterLast("/").ifEmpty { "battery_log.json" }

                val newUuid = when (settings.selectedProvider) {
                    "filen" -> {
                        if (settings.apiKey.isEmpty()) return@launch
                        val filenRepo = FilenRepository()
                        val parentUuid = settings.parentFolderUuid.ifEmpty {
                            filenRepo.getRootFolderUuid(settings.apiKey)
                        }
                        filenRepo.logBattery(
                            settings.apiKey, settings.masterKeys, settings.fileUuid,
                            parentUuid, fileName, batteryLevel, settings.maxLogEntries
                        )
                    }
                    "google_drive" -> {
                        val account = GoogleSignIn.getLastSignedInAccount(appContext)
                            ?: return@launch
                        val token = GoogleAuthUtil.getToken(
                            appContext, account.account!!,
                            "oauth2:https://www.googleapis.com/auth/drive"
                        )
                        val parentId = settings.parentFolderUuid.ifEmpty { "root" }
                        GoogleDriveRepository().logBattery(
                            token, settings.fileUuid, parentId,
                            fileName, batteryLevel, settings.maxLogEntries
                        )
                    }
                    else -> return@launch
                }

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
