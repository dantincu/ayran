package com.ayran.csdrive_webhost_tauriapp

import android.app.Activity
import android.content.Intent
import android.net.Uri
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * External web sites on Android (see `external_sites.rs`): each one is shown full screen in an activity of
 * its own, [ExternalSiteActivity] — a plain [android.webkit.WebView], **not** the app's webview — so it has
 * no bridge to the backend at all (no JavaScript interface, no Tauri IPC) and can only go to other
 * http/https addresses (never to one of our own `*.localhost` origins). Back goes back in the site's
 * history and then closes it.
 *
 * Rust opens one with [open] and then polls [drain] for what happened: one line per event,
 * `url<TAB>id<TAB>address`, `title<TAB>id<TAB>title` or `closed<TAB>id<TAB>`.
 */
object ExternalSites {
    // The sites showing now, by page guid (UI thread only).
    private val showing = HashMap<String, ExternalSiteActivity>()
    private val events = ConcurrentLinkedQueue<String>()

    /** Whether a site's window may go to `uri`: http or https with a host, no user name, and not one of the
     * app's own origins. (The same rule `external_sites::may_navigate_to` applies on desktop.) */
    fun allowed(uri: Uri): Boolean {
        val scheme = uri.scheme?.lowercase() ?: return false
        if (scheme == "about") return uri.toString() == "about:blank"
        if (scheme != "http" && scheme != "https") return false
        val host = uri.host?.lowercase() ?: return false
        if (host.isEmpty() || host.endsWith(".localhost")) return false
        return uri.userInfo == null
    }

    fun note(kind: String, id: String, value: String) {
        events.add("$kind\t$id\t${value.replace('\n', ' ').replace('\t', ' ')}")
    }

    fun register(id: String, activity: ExternalSiteActivity) {
        showing[id] = activity
    }

    fun unregister(id: String, activity: ExternalSiteActivity) {
        if (showing[id] === activity) showing.remove(id)
    }

    @JvmStatic
    fun open(activity: Activity, id: String, url: String) {
        activity.startActivity(intent(activity, id).putExtra(ExternalSiteActivity.EXTRA_URL, url))
    }

    /** Brings a showing site's task to the front (`documentLaunchMode="intoExisting"`: the same intent finds it). */
    @JvmStatic
    fun focus(activity: Activity, id: String) {
        if (showing.containsKey(id)) activity.startActivity(intent(activity, id))
    }

    // A site is a task of its own in the Recents screen, like a window: what tells one from another is the intent's data.
    private fun intent(activity: Activity, id: String) =
        Intent(activity, ExternalSiteActivity::class.java)
            .setData(Uri.parse("csdrive-site://$id"))
            .putExtra(ExternalSiteActivity.EXTRA_ID, id)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NEW_DOCUMENT)

    /** A link to the web clicked in one of the app's pages: the person's browser opens it. */
    @JvmStatic
    fun openInBrowser(activity: Activity, url: String) {
        val uri = Uri.parse(url)
        if (uri.scheme != "http" && uri.scheme != "https") return
        try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: Exception) {
            // No browser to open it: nothing else to do.
        }
    }

    @JvmStatic
    fun close(id: String) {
        showing[id]?.finishAndRemoveTask()
    }

    /** The events since the last call, one per line ("" when there are none). */
    @JvmStatic
    fun drain(): String {
        val out = StringBuilder()
        while (true) {
            val event = events.poll() ?: break
            out.append(event).append('\n')
        }
        return out.toString()
    }
}
