package io.ayran.snipandsketch.screencapture

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.Base64
import android.util.DisplayMetrics
import androidx.core.app.NotificationCompat
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import java.io.ByteArrayOutputStream

/**
 * Holds the MediaProjection session and grabs a single frame as a foreground service.
 * Runs as a service (rather than inline in the plugin/activity) because the capturing
 * app is briefly sent to the background so the frame reflects whatever app the user
 * switched to, and only a foreground service is allowed to keep a MediaProjection alive
 * while backgrounded.
 */
class ScreenCaptureService : Service() {
    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var handlerThread: HandlerThread? = null
    private var resolved = false

    companion object {
        private const val EXTRA_RESULT_CODE = "resultCode"
        private const val EXTRA_RESULT_DATA = "resultData"
        private const val NOTIFICATION_CHANNEL_ID = "screen_capture"
        private const val NOTIFICATION_ID = 4821

        /** How long we wait after backgrounding the app before grabbing the frame. */
        private const val CAPTURE_DELAY_MS = 1500L

        var pendingInvoke: Invoke? = null

        fun start(activity: Activity, resultCode: Int, resultData: Intent) {
            val intent = Intent(activity, ScreenCaptureService::class.java)
                .putExtra(EXTRA_RESULT_CODE, resultCode)
                .putExtra(EXTRA_RESULT_DATA, resultData)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                activity.startForegroundService(intent)
            } else {
                activity.startService(intent)
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification())

        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
            ?: Activity.RESULT_CANCELED
        val resultData = intent?.getParcelableExtra<Intent>(EXTRA_RESULT_DATA)

        if (resultCode != Activity.RESULT_OK || resultData == null) {
            failAndStop("Missing screen capture consent data")
            return START_NOT_STICKY
        }

        handlerThread = HandlerThread("ScreenCaptureThread").apply { start() }
        val handler = Handler(handlerThread!!.looper)

        handler.postDelayed({ beginCapture(resultCode, resultData, handler) }, CAPTURE_DELAY_MS)

        return START_NOT_STICKY
    }

    private fun beginCapture(resultCode: Int, resultData: Intent, handler: Handler) {
        val projectionManager =
            getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val projection: MediaProjection = try {
            projectionManager.getMediaProjection(resultCode, resultData)
                ?: return failAndStop("Failed to obtain a MediaProjection session")
        } catch (e: SecurityException) {
            return failAndStop("Screen capture permission was revoked: ${e.message}")
        }
        mediaProjection = projection

        val metrics = DisplayMetrics()
        val windowManager = getSystemService(Context.WINDOW_SERVICE) as android.view.WindowManager
        @Suppress("DEPRECATION")
        windowManager.defaultDisplay.getRealMetrics(metrics)
        val width = metrics.widthPixels
        val height = metrics.heightPixels
        val density = metrics.densityDpi

        val reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        imageReader = reader

        projection.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                if (!resolved) failAndStop("Screen capture session ended unexpectedly")
            }
        }, handler)

        reader.setOnImageAvailableListener({ r ->
            val image = r.acquireLatestImage() ?: return@setOnImageAvailableListener
            try {
                val plane = image.planes[0]
                val pixelStride = plane.pixelStride
                val rowStride = plane.rowStride
                val rowPadding = rowStride - pixelStride * width

                val bitmap = Bitmap.createBitmap(
                    width + rowPadding / pixelStride,
                    height,
                    Bitmap.Config.ARGB_8888
                )
                bitmap.copyPixelsFromBuffer(plane.buffer)
                val cropped = Bitmap.createBitmap(bitmap, 0, 0, width, height)

                val output = ByteArrayOutputStream()
                cropped.compress(Bitmap.CompressFormat.PNG, 100, output)
                val base64 = Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)

                val res = JSObject()
                res.put("base64Png", base64)
                resolved = true
                pendingInvoke?.resolve(res)
                pendingInvoke = null

                bitmap.recycle()
                cropped.recycle()
            } catch (e: Exception) {
                failAndStop("Failed to capture screen: ${e.message}")
            } finally {
                image.close()
                bringActivityToFront()
                stopSelfCapture()
            }
        }, handler)

        virtualDisplay = projection.createVirtualDisplay(
            "AyranSnipAndSketchCapture",
            width, height, density,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader.surface, null, handler
        )
    }

    private fun bringActivityToFront() {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName) ?: return
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        startActivity(launchIntent)
    }

    private fun failAndStop(message: String) {
        if (!resolved) {
            resolved = true
            pendingInvoke?.reject(message)
            pendingInvoke = null
            bringActivityToFront()
        }
        stopSelfCapture()
    }

    private fun stopSelfCapture() {
        cleanup()
        // Android's background-activity-launch policy often blocks bringActivityToFront()
        // silently, so leave a tappable notification behind as the reliable way back
        // instead of removing it immediately.
        postReturnPromptNotification()
        stopForeground(STOP_FOREGROUND_DETACH)
        stopSelf()
    }

    private fun postReturnPromptNotification() {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val contentIntent = launchIntent?.let {
            PendingIntent.getActivity(
                this, 0, it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }
        val notification = NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setContentTitle(if (resolved) "Screenshot captured" else "Screenshot capture failed")
            .setContentText("Tap to return to Snip & Sketch")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setContentIntent(contentIntent)
            .setAutoCancel(true)
            .build()
        manager.notify(NOTIFICATION_ID, notification)
    }

    private fun cleanup() {
        virtualDisplay?.release()
        virtualDisplay = null
        imageReader?.close()
        imageReader = null
        mediaProjection?.stop()
        mediaProjection = null
        handlerThread?.quitSafely()
        handlerThread = null
    }

    private fun buildNotification(): Notification {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                "Screen Capture",
                NotificationManager.IMPORTANCE_LOW
            )
            manager.createNotificationChannel(channel)
        }

        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val contentIntent = launchIntent?.let {
            PendingIntent.getActivity(
                this, 0, it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        return NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setContentTitle("Capturing screen…")
            .setContentText("Tap to return to Snip & Sketch")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .build()
    }

    override fun onDestroy() {
        cleanup()
        super.onDestroy()
    }
}
