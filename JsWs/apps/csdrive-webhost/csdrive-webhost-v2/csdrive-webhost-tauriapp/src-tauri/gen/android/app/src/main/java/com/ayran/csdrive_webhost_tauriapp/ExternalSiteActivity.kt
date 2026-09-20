package com.ayran.csdrive_webhost_tauriapp

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowInsets
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.window.OnBackInvokedDispatcher

/**
 * One external web site, full screen (see [ExternalSites]). It is an activity of its own rather than a
 * dialog over the app: a dialog never got the keyboard focus (the app's activity kept it), so Back went
 * to the app instead of to the site.
 *
 * Its [WebView] is a plain one — no JavaScript interface, no Tauri bridge — and follows only addresses
 * [ExternalSites.allowed] accepts. It reports its address (also when the page changes it itself, with
 * `history.pushState`), its title and its closing to [ExternalSites], where Rust picks them up.
 */
class ExternalSiteActivity : Activity() {
    private var siteId = ""
    private var web: WebView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val id = intent.getStringExtra(EXTRA_ID)
        val url = intent.getStringExtra(EXTRA_URL)
        if (id == null || url == null) {
            finish()
            return
        }
        siteId = id
        val dp = { value: Int -> TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt() }

        val title = TextView(this).apply {
            text = url
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            setTextColor(Color.WHITE)
            setTypeface(typeface, Typeface.BOLD)
            textSize = 14f
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        val close = Button(this).apply {
            text = "✕"
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.TRANSPARENT)
            setOnClickListener { finish() }
        }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.parseColor("#1f2937"))
            setPadding(dp(12), dp(4), dp(4), dp(4))
            addView(title)
            addView(close)
        }

        val view = WebView(this)
        web = view
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        }
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean = !ExternalSites.allowed(request.url)

            // Also called for a change of address the page makes itself (history.pushState).
            override fun doUpdateVisitedHistory(v: WebView, address: String?, isReload: Boolean) {
                if (address != null && ExternalSites.allowed(Uri.parse(address))) ExternalSites.note("url", id, address)
            }
        }
        view.webChromeClient = object : WebChromeClient() {
            override fun onReceivedTitle(v: WebView, pageTitle: String?) {
                if (!pageTitle.isNullOrBlank()) {
                    title.text = pageTitle
                    ExternalSites.note("title", id, pageTitle)
                }
            }
        }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
            addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(view, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        }
        // Edge to edge (Android 15+ does it for every app): keep the bar out from under the status bar and the
        // page above the gesture bar.
        root.setOnApplyWindowInsetsListener { v, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            } else {
                @Suppress("DEPRECATION")
                v.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            }
            insets
        }
        setContentView(root)

        // Back goes back in the site's own history, and closes it only when there is none. Android 13+ sends
        // Back to a registered callback (and no longer calls onBackPressed once an app opts in to predictive
        // back, which targetSdk 36 does); older versions call onBackPressed.
        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { goBackOrClose() }
        }

        ExternalSites.register(id, this)
        if (savedInstanceState == null) view.loadUrl(url)
    }

    private fun goBackOrClose() {
        val view = web
        if (view != null && view.canGoBack()) view.goBack() else finish()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        goBackOrClose()
    }

    override fun onDestroy() {
        ExternalSites.unregister(siteId, this)
        web?.let {
            it.stopLoading()
            it.destroy()
        }
        web = null
        if (siteId.isNotEmpty()) ExternalSites.note("closed", siteId, "")
        super.onDestroy()
    }

    companion object {
        const val EXTRA_ID = "id"
        const val EXTRA_URL = "url"
    }
}
