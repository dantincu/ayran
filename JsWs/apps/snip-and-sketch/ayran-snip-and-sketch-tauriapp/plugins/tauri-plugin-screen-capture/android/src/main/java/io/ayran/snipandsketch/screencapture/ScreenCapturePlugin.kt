package io.ayran.snipandsketch.screencapture

import android.Manifest
import android.app.Activity
import android.content.Context
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

private const val NOTIFICATION_PERMISSION_ALIAS = "postNotifications"

@TauriPlugin(
    permissions = [
        Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = NOTIFICATION_PERMISSION_ALIAS)
    ]
)
class ScreenCapturePlugin(private val activity: Activity) : Plugin(activity) {
    private lateinit var projectionManager: MediaProjectionManager

    override fun load(webView: WebView) {
        projectionManager =
            activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
    }

    /**
     * Requests the user's one-time consent to capture the screen, then hands off to
     * [ScreenCaptureService], which does the actual frame grab as a foreground service
     * (required so the projection survives our app being sent to the background).
     *
     * Also requests POST_NOTIFICATIONS first (Android 13+): the service posts a "tap to
     * return" notification because Android usually blocks it from bringing our activity
     * back to the foreground itself, and that notification is silently dropped without
     * this runtime grant.
     */
    @Command
    fun capture(invoke: Invoke) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
            invoke.reject("Screen capture requires Android 5.0 (API 21) or newer")
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            getPermissionState(NOTIFICATION_PERMISSION_ALIAS) != app.tauri.PermissionState.GRANTED
        ) {
            requestPermissionForAlias(NOTIFICATION_PERMISSION_ALIAS, invoke, "startCapture")
        } else {
            startCapture(invoke)
        }
    }

    @PermissionCallback
    private fun startCapture(invoke: Invoke) {
        startActivityForResult(invoke, projectionManager.createScreenCaptureIntent(), "handleCaptureResult")
    }

    @ActivityCallback
    private fun handleCaptureResult(invoke: Invoke, result: ActivityResult) {
        val data = result.data
        if (result.resultCode != Activity.RESULT_OK || data == null) {
            invoke.reject("User denied the screen capture permission")
            return
        }

        ScreenCaptureService.pendingInvoke = invoke
        ScreenCaptureService.start(activity, result.resultCode, data)

        // Reveal whatever was behind this app so the capture reflects it, not our own UI;
        // ScreenCaptureService brings the activity back to front once the frame is grabbed.
        activity.moveTaskToBack(true)
    }
}
