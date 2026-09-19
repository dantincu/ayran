package com.ayran.csdrive_webhost_tauriapp

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.text.InputType
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.android.material.button.MaterialButton
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import java.io.File

/**
 * Our own folder picker (see `picked_roots.rs`): Android has no folder-picking dialog that hands
 * back a real path — the system one gives content URIs, which the rest of the app (the fs plugin,
 * SQLite, web apps) can't use — so this browses the real filesystem itself.
 *
 * That needs Android's "All files access" (API 30+) or the classic storage permissions (older),
 * asked for the first time a folder is picked.
 *
 * Rust starts it with [start] and then polls [poll] until it stops saying "pending":
 * "picked:<absolute path>", "cancelled" or "error:<message>".
 */
object FolderPicker {
  private const val REQUEST_CODE = 4711

  @Volatile private var result = "cancelled"
  private var awaitingAccess = false

  @JvmStatic
  fun poll(): String = result

  /** Shows the picker (asking for storage access first if needed). Runs on the UI thread. */
  @JvmStatic
  fun start(activity: Activity) {
    if (result == "pending") return // one picker at a time; the caller keeps polling the open one
    result = "pending"
    if (hasAccess(activity)) show(activity) else requestAccess(activity)
  }

  /** The activity came back to the front — perhaps from the system settings page opened by [requestAccess]. */
  fun onResume(activity: Activity) {
    if (!awaitingAccess) return
    awaitingAccess = false
    if (hasAccess(activity)) show(activity) else result = "error:Storage access wasn't granted, so folders can't be browsed."
  }

  fun onPermissionsResult(activity: Activity, requestCode: Int) {
    if (requestCode != REQUEST_CODE || result != "pending") return
    if (hasAccess(activity)) show(activity) else result = "error:Storage access wasn't granted, so folders can't be browsed."
  }

  // ── Storage access ──────────────────────────────────────────────────────────

  private fun hasAccess(context: Context): Boolean =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      Environment.isExternalStorageManager()
    } else {
      listOf(Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE).all {
        ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
      }
    }

  private fun requestAccess(activity: Activity) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      awaitingAccess = true
      try {
        activity.startActivity(
          Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${activity.packageName}"))
        )
      } catch (e: ActivityNotFoundException) {
        activity.startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
      }
    } else {
      ActivityCompat.requestPermissions(
        activity,
        arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE),
        REQUEST_CODE,
      )
    }
  }

  // ── The dialog ──────────────────────────────────────────────────────────────

  private fun show(activity: Activity) {
    try {
      PickerDialog(activity).show()
    } catch (e: Exception) {
      result = "error:" + (e.message ?: e.javaClass.simpleName)
    }
  }

  /** The storage volumes a person can start from: internal storage, then any SD card / USB drive. */
  private fun volumes(context: Context): List<Pair<String, File>> {
    val list = mutableListOf("Internal storage" to Environment.getExternalStorageDirectory())
    context.getExternalFilesDirs(null).drop(1).filterNotNull().forEach { dir ->
      val root = dir.absolutePath.substringBefore("/Android/")
      if (root != dir.absolutePath) list += "SD card / USB (${File(root).name})" to File(root)
    }
    return list
  }

  private class Row(val label: String, val target: File?, val kind: Int) {
    companion object {
      const val UP = 0
      const val FOLDER = 1
      const val NOTE = 2
    }
  }

  private class PickerDialog(private val activity: Activity) {
    private val density = activity.resources.displayMetrics.density
    private val volumes = volumes(activity)
    private val rows = mutableListOf<Row>()
    private var current: File? = null

    private lateinit var dialog: AlertDialog
    private lateinit var useButton: MaterialButton
    private lateinit var newFolderButton: MaterialButton
    private val pathView = TextView(activity)
    private val listView = ListView(activity)

    private fun dp(v: Int) = (v * density).toInt()

    private fun themeColor(attr: Int): Int {
      val value = TypedValue()
      activity.theme.resolveAttribute(attr, value, true)
      return if (value.resourceId != 0) ContextCompat.getColor(activity, value.resourceId) else value.data
    }

    private val adapter = object : BaseAdapter() {
      override fun getCount() = rows.size
      override fun getItem(position: Int) = rows[position]
      override fun getItemId(position: Int) = position.toLong()
      override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
        val row = rows[position]
        val view = (convertView as? TextView) ?: TextView(activity).apply {
          setPadding(dp(8), dp(13), dp(8), dp(13))
          setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
          maxLines = 2
          ellipsize = TextUtils.TruncateAt.END
        }
        view.text = when (row.kind) {
          Row.UP -> "⬆  ${row.label}"
          Row.FOLDER -> "📁  ${row.label}"
          else -> row.label
        }
        view.setTextColor(themeColor(if (row.kind == Row.NOTE) android.R.attr.textColorSecondary else android.R.attr.textColorPrimary))
        return view
      }
      override fun isEnabled(position: Int) = rows[position].kind != Row.NOTE
    }

    fun show() {
      val title = TextView(activity).apply {
        text = "Choose a folder"
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
        setTypeface(typeface, android.graphics.Typeface.BOLD)
        setTextColor(themeColor(android.R.attr.textColorPrimary))
      }
      pathView.apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        setTextColor(themeColor(android.R.attr.textColorSecondary))
        maxLines = 1
        ellipsize = TextUtils.TruncateAt.START // keep the end of a long path — the part that matters
        setPadding(0, dp(4), 0, dp(8))
      }
      listView.adapter = adapter
      listView.setOnItemClickListener { _, _, position, _ ->
        val row = rows[position]
        if (row.kind == Row.UP) navigate(row.target) else if (row.kind == Row.FOLDER) navigate(row.target)
      }

      newFolderButton = MaterialButton(activity, null, androidx.appcompat.R.attr.borderlessButtonStyle).apply {
        text = "New folder"
        isAllCaps = false
        setOnClickListener { askForNewFolder() }
      }
      val cancelButton = MaterialButton(activity, null, androidx.appcompat.R.attr.borderlessButtonStyle).apply {
        text = "Cancel"
        isAllCaps = false
        setOnClickListener { dialog.cancel() }
      }
      useButton = MaterialButton(activity).apply {
        text = "Use this folder"
        isAllCaps = false
        setOnClickListener {
          current?.let {
            result = "picked:" + it.absolutePath
            dialog.dismiss()
          }
        }
      }
      val header = LinearLayout(activity).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        addView(newFolderButton)
      }
      val buttons = LinearLayout(activity).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL or Gravity.END
        addView(cancelButton)
        addView(useButton)
      }

      val root = LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(20), dp(20), dp(20), dp(8))
        addView(header)
        addView(pathView)
        addView(listView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        addView(buttons)
        // The same height whatever is listed, so the dialog doesn't jump around as you move between folders.
        val height = (activity.resources.displayMetrics.heightPixels * 0.72).toInt()
        minimumHeight = height
        layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, height)
      }

      dialog = MaterialAlertDialogBuilder(activity).setView(root).create()
      dialog.setCanceledOnTouchOutside(false)
      dialog.setOnDismissListener { if (result == "pending") result = "cancelled" }

      // Start where people keep things: internal storage.
      navigate(volumes.first().second)
      dialog.show()
    }

    /** Shows `dir`'s subfolders; `null` shows the list of storage volumes. */
    private fun navigate(dir: File?) {
      current = dir
      rows.clear()
      if (dir == null) {
        volumes.forEach { (name, file) -> rows += Row(name, file, Row.FOLDER) }
      } else {
        // Going up from a volume's root leads to the list of volumes, not out of the volume.
        val isVolumeRoot = volumes.any { it.second.absolutePath == dir.absolutePath }
        val parent = dir.parentFile
        rows += Row("Up", if (isVolumeRoot || parent == null || !parent.canRead()) null else parent, Row.UP)
        val children = try {
          dir.listFiles { file -> file.isDirectory }?.sortedBy { it.name.lowercase() }
        } catch (e: SecurityException) {
          null
        }
        when {
          children == null -> rows += Row("This folder can't be opened.", null, Row.NOTE)
          children.isEmpty() -> rows += Row("No subfolders here.", null, Row.NOTE)
          else -> children.forEach { rows += Row(it.name, it, Row.FOLDER) }
        }
      }
      pathView.text = dir?.absolutePath ?: "Storage"
      useButton.isEnabled = dir != null
      newFolderButton.isEnabled = dir != null && dir.canWrite()
      adapter.notifyDataSetChanged()
      listView.setSelection(0)
    }

    private fun askForNewFolder() {
      val parent = current ?: return
      val input = EditText(activity).apply {
        inputType = InputType.TYPE_CLASS_TEXT
        hint = "Folder name"
        setSingleLine()
      }
      val holder = LinearLayout(activity).apply {
        setPadding(dp(24), dp(8), dp(24), 0)
        addView(input, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
      }
      MaterialAlertDialogBuilder(activity)
        .setTitle("New folder")
        .setView(holder)
        .setNegativeButton("Cancel", null)
        .setPositiveButton("Create") { _, _ ->
          val name = input.text.toString().trim()
          val created = File(parent, name)
          when {
            name.isEmpty() || name == "." || name == ".." || name.contains('/') ->
              Toast.makeText(activity, "That isn't a usable folder name.", Toast.LENGTH_SHORT).show()
            created.exists() -> Toast.makeText(activity, "\"$name\" already exists here.", Toast.LENGTH_SHORT).show()
            created.mkdir() -> navigate(created)
            else -> Toast.makeText(activity, "Couldn't create the folder.", Toast.LENGTH_SHORT).show()
          }
        }
        .show()
    }
  }
}
