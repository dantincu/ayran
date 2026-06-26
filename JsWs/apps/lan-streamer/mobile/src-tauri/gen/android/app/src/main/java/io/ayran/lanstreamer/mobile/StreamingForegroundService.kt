package io.ayran.lanstreamer.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/**
 * Keeps hosting/listening alive with the screen off or the app backgrounded.
 * Android suspends or kills ordinary background app processes fairly
 * aggressively (Doze, App Standby, per-app background limits) - a foreground
 * service with an ongoing notification is the documented way to be exempted
 * from that, the same mechanism music/calling apps use. The notification
 * itself isn't optional - it's how Android keeps the user informed that
 * something is using resources in the background, not a choice we can skip.
 */
class StreamingForegroundService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null

    companion object {
        private const val CHANNEL_ID = "lan-streamer-active"
        private const val NOTIFICATION_ID = 1
        private const val EXTRA_ROLE = "role"

        // Called from Rust via JNI (see mobile/src-tauri/src/foreground_service.rs)
        // rather than exposing a Tauri plugin for what's otherwise two one-line
        // calls - role is "hosting-microphone", "hosting-test-tone", or
        // "listening", used to pick the notification text and the matching
        // foregroundServiceType. The "microphone" FGS type specifically
        // requires RECORD_AUDIO already granted, so it's only ever requested
        // for the role that's actually capturing the mic - test-tone hosting
        // doesn't touch the mic at all and shouldn't need that permission.
        @JvmStatic
        fun start(context: Context, role: String) {
            val intent = Intent(context, StreamingForegroundService::class.java)
            intent.putExtra(EXTRA_ROLE, role)
            context.startForegroundService(intent)
        }

        @JvmStatic
        fun stop(context: Context) {
            context.stopService(Intent(context, StreamingForegroundService::class.java))
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val role = intent?.getStringExtra(EXTRA_ROLE) ?: "streaming"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, buildNotification(role), foregroundServiceTypeFor(role))
        } else {
            startForeground(NOTIFICATION_ID, buildNotification(role))
        }
        return START_STICKY
    }

    override fun onCreate() {
        super.onCreate()
        // A foreground service is already exempt from most background CPU
        // restrictions, but a partial wake lock additionally keeps the CPU
        // from fully sleeping while the screen is off, so the WebView's
        // audio/WebSocket work doesn't stall.
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "LanStreamer::StreamingWakeLock")
        wakeLock?.acquire()
    }

    override fun onDestroy() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        super.onDestroy()
    }

    private fun foregroundServiceTypeFor(role: String): Int =
        if (role == "hosting-microphone") ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK

    private fun buildNotification(role: String): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (manager.getNotificationChannel(CHANNEL_ID) == null) {
                manager.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "Streaming", NotificationManager.IMPORTANCE_LOW),
                )
            }
        }

        val openAppIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingIntent = PendingIntent.getActivity(this, 0, openAppIntent, PendingIntent.FLAG_IMMUTABLE)

        val text = if (role.startsWith("hosting")) "Hosting an audio stream" else "Listening to an audio stream"
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Ayran LAN Streamer")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build()
    }
}
