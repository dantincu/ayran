package com.ayran.csdrive_webhost_tauriapp

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.os.SystemClock
import android.provider.Settings
import android.view.View

/**
 * The loading spinner: a track ring with a quarter arc turning once every 0.8 s — the same
 * look as the page's own (`.app-spinner` in App.css).
 *
 * It draws itself from the clock instead of using a framework animation. Material's
 * indeterminate indicator (like every `Animator`) is switched off by Android's "remove
 * animations" / animator-scale-0 setting and then shows a static icon or nothing at all —
 * exactly when a person is most likely to be looking at a spinner that never moves.
 */
class SplashSpinnerView(
  context: Context,
  private val accent: Int,
  private val track: Int,
  private val sizePx: Int,
  private val strokePx: Float,
) : View(context) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeWidth = strokePx
  }
  private val oval = RectF()

  // Turn slowly (like the page's reduced-motion rule) if the person asked for no animation.
  private val periodMs =
    if (Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f) 2400L else 800L

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(sizePx, sizePx)
  }

  override fun onDraw(canvas: Canvas) {
    val inset = strokePx / 2
    oval.set(inset, inset, width - inset, height - inset)

    paint.color = track
    canvas.drawArc(oval, 0f, 360f, false, paint)

    val turn = (SystemClock.uptimeMillis() % periodMs) / periodMs.toFloat()
    paint.color = accent
    canvas.drawArc(oval, turn * 360f - 90f, 90f, false, paint)

    postInvalidateOnAnimation() // next frame
  }
}
