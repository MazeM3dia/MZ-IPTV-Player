package com.mazem3dia.iptv

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.app.UiModeManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.ApplicationInfo
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.annotation.OptIn
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.DecoderReuseEvaluation
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.Renderer
import androidx.media3.exoplayer.mediacodec.MediaCodecInfo
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.util.EventLogger
import androidx.media3.exoplayer.video.MediaCodecVideoRenderer
import androidx.media3.exoplayer.video.VideoRendererEventListener
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.roundToInt

/**
 * Hybrid player: ExoPlayer draws the video at the bottom, the shared web UI
 * (web/index.html, packaged as an asset) sits on top in a transparent WebView.
 *
 *   page → native   window.MZNative.play(url, isHls, userAgent, referrer) / togglePause() / setMuted(b) / exit()
 *                   setVideoRect(x, y, w, h)  where to draw the video (portrait phone: the 16:9 box on top)
 *                   setLandscape(b)           phone fullscreen button: hold the screen sideways
 *                   fetch("/proxy?url=…") — playlist download without browser CORS rules
 *   native → page   mzOnNative({type:"state"|"error", …})  player state
 *                   mzOnRemote("Back"|"Menu"|…)            remote keys the WebView never sees
 *                   mzOnResume()                           app is back on screen (playlist refresh check)
 */
@OptIn(UnstableApi::class)
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private lateinit var playerView: PlayerView
    private lateinit var player: ExoPlayer
    private lateinit var http: DefaultHttpDataSource.Factory
    private lateinit var assetLoader: WebViewAssetLoader
    private val main = Handler(Looper.getMainLooper())

    private var currentUrl: String? = null
    private var currentIsHls = false
    private var retriedAsHls = false
    private var resumeOnStart = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val debuggable = applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        if (debuggable) WebView.setWebContentsDebuggingEnabled(true)   // chrome://inspect

        http = DefaultHttpDataSource.Factory()
            .setUserAgent(USER_AGENT)
            .setAllowCrossProtocolRedirects(true)   // http ↔ https redirects are common in IPTV
            .setConnectTimeoutMs(10_000)
            .setReadTimeoutMs(15_000)
        player = ExoPlayer.Builder(this, PlayerRenderers(this))
            .setMediaSourceFactory(DefaultMediaSourceFactory(DefaultDataSource.Factory(this, http)))
            .setAudioAttributes(
                AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(),
                /* handleAudioFocus = */ true,
            )
            .build()
        player.addListener(playerListener)
        // Debug builds: log every format/size change, dropped frame and decoder event (Logcat tag MZIPTV-player)
        if (debuggable) player.addAnalyticsListener(EventLogger("MZIPTV-player"))

        playerView = PlayerView(this).apply {
            useController = false
            resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
            setShutterBackgroundColor(Color.BLACK)
            isFocusable = false
            descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
            player = this@MainActivity.player
        }

        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
            setBackgroundColor(Color.TRANSPARENT)   // video shows through the page
            overScrollMode = View.OVER_SCROLL_NEVER
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
            isFocusable = true
            isFocusableInTouchMode = true
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true   // localStorage: favourites, history, filters
                mediaPlaybackRequiresUserGesture = false
                mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW   // http:// channel logos
                allowFileAccess = false
                allowContentAccess = false
                userAgentString = "$userAgentString $USER_AGENT"
            }
            addJavascriptInterface(Bridge(), "MZNative")
            webViewClient = PageClient()
            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                    Log.d(TAG, "page: ${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                    return true
                }
            }
        }

        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(playerView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(webView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        }
        setContentView(root)

        // System bars. We lay out between them ourselves (Android 15 draws apps behind
        // the bars by default): the root is padded by the visible bars, the notch and
        // the on-screen keyboard, so the page and the video never sit underneath them.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
        applySystemBars(resources.configuration)

        // Phones / gesture navigation: route system Back through the page too.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = sendBack()
        })

        webView.loadUrl(START_URL)
        checkWebViewVersion()
        webView.requestFocus()
    }

    // ------------------------------------------------------------------
    // Remote keys. D-pad, OK and digits go to the WebView as normal DOM
    // key events. These buttons never reach the page, so forward them.
    // ------------------------------------------------------------------
    // Activity.dispatchKeyEvent is public API; lint only objects because AndroidX's
    // ComponentActivity re-declares it @RestrictTo (known false positive).
    @SuppressLint("RestrictedApi")
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        // Game-controller A / Select and keypad Enter are "select" too (Android TV
        // input guidelines): hand them to the page as the remote's OK, so hold-OK works.
        if (event.keyCode in SELECT_KEYS) {
            return super.dispatchKeyEvent(KeyEvent(
                event.downTime, event.eventTime, event.action, KeyEvent.KEYCODE_DPAD_CENTER,
                event.repeatCount, event.metaState, event.deviceId, event.scanCode, event.flags, event.source,
            ))
        }
        val name = REMOTE_KEYS[event.keyCode] ?: return super.dispatchKeyEvent(event)
        when {
            name == "Back" -> if (event.action == KeyEvent.ACTION_UP && !event.isCanceled) sendBack()
            event.action == KeyEvent.ACTION_DOWN && (event.repeatCount == 0 || name in REPEATABLE) -> sendRemote(name)
        }
        return true
    }

    private fun sendRemote(name: String) {
        webView.evaluateJavascript("window.mzOnRemote ? mzOnRemote('$name') : false", null)
    }

    /** The page decides what Back does; if it doesn't consume it, leave the app. */
    private fun sendBack() {
        webView.evaluateJavascript("window.mzOnRemote ? mzOnRemote('Back') : false") { result ->
            if (result != "true") finish()
        }
    }

    // ------------------------------------------------------------------
    // Page → native bridge. Called on a WebView binder thread: hop to main,
    // and drop calls that land while the app is closing (player released).
    // ------------------------------------------------------------------
    private fun onMain(block: () -> Unit) {
        main.post { if (!isFinishing && !isDestroyed) block() }
    }

    inner class Bridge {
        /** userAgent / referrer: from the playlist (http-user-agent, http-referrer, #EXTVLCOPT); "" = none. */
        @JavascriptInterface fun play(url: String, isHls: Boolean, userAgent: String, referrer: String) {
            onMain { startPlayback(url, isHls, userAgent, referrer) }
        }
        @JavascriptInterface fun togglePause() { onMain { togglePlayback() } }
        @JavascriptInterface fun setMuted(muted: Boolean) { onMain { player.volume = if (muted) 0f else 1f } }
        @JavascriptInterface fun exit() { main.post { finish() } }
        /** CSS px from the page; w or h <= 0 = whole screen. */
        @JavascriptInterface fun setVideoRect(x: Double, y: Double, w: Double, h: Double) {
            onMain { placeVideo(x, y, w, h) }
        }
        @JavascriptInterface fun setLandscape(on: Boolean) {
            onMain {
                requestedOrientation =
                    if (on) ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            }
        }
        @JavascriptInterface fun isTv(): Boolean = isTvDevice()
    }

    private fun isTvDevice(): Boolean =
        (getSystemService(UI_MODE_SERVICE) as UiModeManager).currentModeType == Configuration.UI_MODE_TYPE_TELEVISION

    /**
     * Phone / tablet portrait: status bar (time, battery) and navigation bar visible.
     * Landscape and TV: both hidden for full-screen video; a swipe from the edge
     * shows them briefly.
     */
    private fun applySystemBars(config: Configuration) {
        val bars = WindowCompat.getInsetsController(window, window.decorView)
        bars.isAppearanceLightStatusBars = false        // white icons on the black app
        bars.isAppearanceLightNavigationBars = false
        if (isTvDevice() || config.orientation == Configuration.ORIENTATION_LANDSCAPE) {
            bars.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            bars.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            bars.show(WindowInsetsCompat.Type.systemBars())
        }
    }

    // Rotation doesn't recreate the activity (configChanges in the manifest), so re-apply here.
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        applySystemBars(newConfig)
    }

    // Coming back from another app / a system dialog can bring the bars back.
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) applySystemBars(resources.configuration)
    }

    /** The WebView fills the window and its CSS px are dp, so page coordinates map straight onto the video view. */
    private fun placeVideo(x: Double, y: Double, w: Double, h: Double) {
        val lp = playerView.layoutParams as FrameLayout.LayoutParams
        if (w <= 0 || h <= 0) {
            lp.width = MATCH_PARENT; lp.height = MATCH_PARENT; lp.leftMargin = 0; lp.topMargin = 0
        } else {
            val d = resources.displayMetrics.density
            lp.leftMargin = (x * d).roundToInt(); lp.topMargin = (y * d).roundToInt()
            lp.width = (w * d).roundToInt(); lp.height = (h * d).roundToInt()
        }
        playerView.layoutParams = lp
    }

    private fun mediaItem(url: String, isHls: Boolean): MediaItem =
        MediaItem.Builder().setUri(url).apply { if (isHls) setMimeType(MimeTypes.APPLICATION_M3U8) }.build()

    private fun startPlayback(url: String, isHls: Boolean, userAgent: String, referrer: String) {
        currentUrl = url
        currentIsHls = isHls
        retriedAsHls = false
        // Some streams refuse requests without the user-agent / referrer the
        // playlist names. The factory applies these to every request it makes
        // from now on (manifest + segments) — reset for each channel.
        http.setUserAgent(userAgent.ifEmpty { USER_AGENT })
        http.setDefaultRequestProperties(if (referrer.isNotEmpty()) mapOf("Referer" to referrer) else emptyMap())
        player.setMediaItem(mediaItem(url, isHls))
        player.prepare()
        player.playWhenReady = true
    }

    private fun togglePlayback() {
        if (currentUrl == null) return
        if (player.playWhenReady) {
            player.pause()
            emit(JSONObject().put("type", "state").put("state", "paused"))
        } else {
            // Live TV: resume at the live edge, not where we paused.
            player.seekToDefaultPosition()
            if (player.playbackState == Player.STATE_IDLE) player.prepare()
            player.play()
        }
    }

    private val playerListener = object : Player.Listener {
        override fun onPlaybackStateChanged(state: Int) {
            when (state) {
                Player.STATE_BUFFERING -> emitState("buffering")
                Player.STATE_READY -> emitState(if (player.playWhenReady) "playing" else "paused")
                Player.STATE_ENDED -> emitError("The stream ended.")
                Player.STATE_IDLE -> Unit
            }
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            playerView.keepScreenOn = isPlaying   // no screensaver mid-show
            if (isPlaying) emitState("playing")
        }

        override fun onPlayerError(error: PlaybackException) {
            val url = currentUrl
            if (error.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW) {
                player.seekToDefaultPosition()
                player.prepare()
                return
            }
            // Some HLS links don't end in .m3u8 — retry once as HLS before giving up.
            if (url != null && !currentIsHls && !retriedAsHls &&
                error.errorCode == PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED
            ) {
                retriedAsHls = true
                player.setMediaItem(mediaItem(url, true))
                player.prepare()
                return
            }
            Log.w(TAG, "playback error ${error.errorCodeName} for $url", error)
            emitError(describe(error))
        }
    }

    /** Human reason for the page's error card. Restricted channels are expected; say why. */
    private fun describe(error: PlaybackException): String {
        val http = generateSequence(error as Throwable) { it.cause }
            .filterIsInstance<HttpDataSource.InvalidResponseCodeException>()
            .firstOrNull()?.responseCode
        return when {
            http == 401 -> "This stream needs a login."
            http == 403 -> "Access denied — the stream is probably geo-restricted."
            http == 404 || http == 410 -> "Stream not found — it's probably offline."
            http != null && http >= 500 -> "The stream's server failed (HTTP $http)."
            http != null -> "The stream's server answered HTTP $http."
            error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED ->
                "Can't connect — the stream is offline or there's no internet."
            error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT ->
                "The stream timed out."
            error.errorCode in 3000..3999 -> "Unsupported or broken stream format."    // ERROR_CODE_PARSING_*
            error.errorCode in 4000..4999 -> "This device can't decode the stream."    // ERROR_CODE_DECODING_*
            else -> "Playback failed (${error.errorCodeName})."
        }
    }

    private fun emitState(state: String) = emit(JSONObject().put("type", "state").put("state", state))
    private fun emitError(reason: String) = emit(JSONObject().put("type", "error").put("reason", reason))
    private fun emit(ev: JSONObject) {
        webView.evaluateJavascript("window.mzOnNative && mzOnNative($ev)", null)
    }

    // ------------------------------------------------------------------
    // Page loading: assets over https://appassets.androidplatform.net and
    // a same-origin /proxy that downloads playlists natively (no CORS).
    // ------------------------------------------------------------------
    private inner class PageClient : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val uri = request.url
            if (uri.host == ASSET_HOST && uri.path == "/proxy") return proxy(uri.getQueryParameter("url"))
            return assetLoader.shouldInterceptRequest(uri)
        }

        // The page is the whole app: never navigate the WebView elsewhere.
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
            request.url.host != ASSET_HOST
    }

    /** Runs on a WebView background thread, so blocking network I/O is fine here. */
    private fun proxy(target: String?): WebResourceResponse {
        if (target == null || !(target.startsWith("http://") || target.startsWith("https://"))) {
            return textResponse(400, "Bad Request", "That doesn't look like an http(s) playlist URL.")
        }
        return try {
            var url = URL(target)
            var conn: HttpURLConnection
            var hops = 0
            while (true) {
                conn = (url.openConnection() as HttpURLConnection).apply {
                    instanceFollowRedirects = false   // followed manually: Java won't cross http ↔ https
                    connectTimeout = 15_000
                    readTimeout = 30_000
                    setRequestProperty("User-Agent", USER_AGENT)
                }
                val code = conn.responseCode
                val location = conn.getHeaderField("Location")
                if (code in 300..399 && location != null && hops++ < 5) {
                    conn.disconnect()
                    url = URL(url, location)
                    continue
                }
                break
            }
            val code = conn.responseCode
            if (code !in 200..299) {
                conn.disconnect()
                return textResponse(502, "Bad Gateway", "The playlist server answered HTTP $code.")
            }
            WebResourceResponse("text/plain", "utf-8", 200, "OK", mapOf("Cache-Control" to "no-store"), conn.inputStream)
        } catch (e: Exception) {
            Log.w(TAG, "playlist download failed: $target", e)
            textResponse(502, "Bad Gateway", "Couldn't download the playlist (${e.message ?: e.javaClass.simpleName}).")
        }
    }

    private fun textResponse(code: Int, reason: String, body: String) =
        WebResourceResponse("text/plain", "utf-8", code, reason, emptyMap(), ByteArrayInputStream(body.toByteArray()))

    // ------------------------------------------------------------------
    // Lifecycle: live TV doesn't "pause" in the background — stop the
    // stream when hidden and re-tune at the live edge when back.
    // ------------------------------------------------------------------
    override fun onStart() {
        super.onStart()
        webView.onResume()
        // Back on screen: let the page re-download the playlist if it's stale.
        webView.evaluateJavascript("window.mzOnResume && mzOnResume()", null)
        if (resumeOnStart) {
            resumeOnStart = false
            player.seekToDefaultPosition()
            player.prepare()
            player.play()
        }
    }

    override fun onStop() {
        super.onStop()
        resumeOnStart = currentUrl != null && player.playWhenReady
        player.stop()
        webView.onPause()
    }

    override fun onDestroy() {
        super.onDestroy()
        player.release()
        (webView.parent as? ViewGroup)?.removeView(webView)   // destroy() wants it detached first
        webView.destroy()
    }

    /**
     * Cheap TV boxes often keep the WebView they shipped with. Below MIN_WEBVIEW the
     * page can't render properly, so say so instead of leaving a broken screen. The
     * user can still carry on. Shown once per WebView version, and Update only when
     * the Play Store has that WebView: many boxes use AOSP's com.android.webview,
     * which only a firmware update can replace.
     */
    private fun checkWebViewVersion() {
        val pkg = WebViewCompat.getCurrentWebViewPackage(this) ?: return
        val major = pkg.versionName?.substringBefore('.')?.toIntOrNull() ?: return
        if (major >= MIN_WEBVIEW) return
        Log.w(TAG, "WebView ${pkg.packageName} $major is older than $MIN_WEBVIEW")
        val prefs = getPreferences(MODE_PRIVATE)
        if (prefs.getInt(PREF_WEBVIEW_WARNED, 0) == major) return
        prefs.edit().putInt(PREF_WEBVIEW_WARNED, major).apply()
        val onPlay = PLAY_WEBVIEWS.any { pkg.packageName.startsWith(it) }
        val dialog = AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle(R.string.webview_old_title)
            .setMessage(getString(if (onPlay) R.string.webview_old_message else R.string.webview_old_message_system, major, MIN_WEBVIEW))
            .setNegativeButton(R.string.webview_old_continue, null)
        if (onPlay) dialog.setPositiveButton(R.string.webview_old_update) { _, _ -> openStorePage(pkg.packageName) }
        dialog.show()
    }

    private fun openStorePage(packageName: String) {
        for (uri in listOf("market://details?id=$packageName", "https://play.google.com/store/apps/details?id=$packageName")) {
            try {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri)))
                return
            } catch (_: ActivityNotFoundException) {
                // no store / browser for this link on this device: try the next one
            }
        }
    }

    /**
     * The emulator's video decoder (c2.goldfish.*) claims it can switch resolution
     * on the fly, but then keeps reporting the previous stream's size: after going
     * 1080p -> 576p the new channel was drawn at the old size (stretched, cropped,
     * or stuck in a corner with the old picture around it). On that decoder, start
     * a fresh one whenever the video format changes. Real devices keep the normal,
     * seamless decoder reuse.
     */
    private class PlayerRenderers(context: Context) : DefaultRenderersFactory(context) {
        override fun buildVideoRenderers(
            context: Context,
            extensionRendererMode: Int,
            mediaCodecSelector: MediaCodecSelector,
            enableDecoderFallback: Boolean,
            eventHandler: Handler,
            eventListener: VideoRendererEventListener,
            allowedVideoJoiningTimeMs: Long,
            out: ArrayList<Renderer>,
        ) {
            out.add(object : MediaCodecVideoRenderer(
                context, codecAdapterFactory, mediaCodecSelector, allowedVideoJoiningTimeMs,
                enableDecoderFallback, eventHandler, eventListener, MAX_DROPPED_VIDEO_FRAME_COUNT_TO_NOTIFY,
            ) {
                override fun canReuseCodec(codecInfo: MediaCodecInfo, oldFormat: Format, newFormat: Format): DecoderReuseEvaluation =
                    if (codecInfo.name.contains("goldfish", ignoreCase = true)) {
                        DecoderReuseEvaluation(
                            codecInfo.name, oldFormat, newFormat,
                            DecoderReuseEvaluation.REUSE_RESULT_NO, DecoderReuseEvaluation.DISCARD_REASON_APP_OVERRIDE,
                        )
                    } else {
                        super.canReuseCodec(codecInfo, oldFormat, newFormat)
                    }
            })
        }
    }

    companion object {
        private const val TAG = "MZIPTV"
        private const val ASSET_HOST = "appassets.androidplatform.net"
        private const val START_URL = "https://$ASSET_HOST/assets/index.html"
        private const val USER_AGENT = "MZIPTV/0.1 (Android TV)"

        // Remote / controller buttons -> names the page understands (mzOnRemote).
        // Sources: Android TV controller guide, Fire TV remote input reference.
        private val REMOTE_KEYS = mapOf(
            KeyEvent.KEYCODE_BACK to "Back",
            KeyEvent.KEYCODE_BUTTON_B to "Back",               // game controller B = back
            KeyEvent.KEYCODE_MENU to "Menu",                   // options menu (Fire TV, Shield, box remotes)
            KeyEvent.KEYCODE_SEARCH to "Search",
            KeyEvent.KEYCODE_GUIDE to "Guide",
            KeyEvent.KEYCODE_INFO to "Info",
            KeyEvent.KEYCODE_CHANNEL_UP to "ChannelUp",
            KeyEvent.KEYCODE_CHANNEL_DOWN to "ChannelDown",
            KeyEvent.KEYCODE_LAST_CHANNEL to "LastChannel",
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE to "PlayPause",
            KeyEvent.KEYCODE_BUTTON_START to "PlayPause",
            KeyEvent.KEYCODE_MEDIA_PLAY to "Play",
            KeyEvent.KEYCODE_MEDIA_PAUSE to "Pause",
            KeyEvent.KEYCODE_MEDIA_STOP to "Pause",
            KeyEvent.KEYCODE_MEDIA_NEXT to "Next",
            KeyEvent.KEYCODE_MEDIA_PREVIOUS to "Previous",
            // Live TV can't seek: rewind / fast-forward (Fire TV and many boxes have
            // these but no CH+/-) and the controller shoulder buttons change channel.
            KeyEvent.KEYCODE_MEDIA_REWIND to "Previous",
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD to "Next",
            KeyEvent.KEYCODE_BUTTON_L1 to "Previous",
            KeyEvent.KEYCODE_BUTTON_R1 to "Next",
            KeyEvent.KEYCODE_BOOKMARK to "Bookmark",           // Google TV-style remotes: favourite
            KeyEvent.KEYCODE_PROG_RED to "Red",
            KeyEvent.KEYCODE_PROG_GREEN to "Green",
            KeyEvent.KEYCODE_PROG_YELLOW to "Yellow",
            KeyEvent.KEYCODE_PROG_BLUE to "Blue",
        )
        private val REPEATABLE = setOf("ChannelUp", "ChannelDown")   // hold CH± to page fast
        private val SELECT_KEYS = setOf(
            KeyEvent.KEYCODE_BUTTON_A, KeyEvent.KEYCODE_BUTTON_SELECT, KeyEvent.KEYCODE_NUMPAD_ENTER,
        )
        // Oldest WebView that renders the page correctly. Flex gap (84) and min() /
        // clamp() (79) have fallbacks in the page; what's left: async/await (55),
        // scrollIntoView options (61), variable fonts (62).
        private const val MIN_WEBVIEW = 62
        private const val PREF_WEBVIEW_WARNED = "webviewWarnedFor"
        // WebView providers the Play Store can update (stable / beta / dev / canary)
        private val PLAY_WEBVIEWS = listOf("com.google.android.webview", "com.android.chrome", "com.chrome.")
    }
}
