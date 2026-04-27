package com.ayran.mobilebatterylogger.ui

import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.ayran.mobilebatterylogger.AppViewModel
import com.ayran.mobilebatterylogger.BrowseState
import com.ayran.mobilebatterylogger.filen.FilenDirItem

@Composable
fun FilenFilePicker(viewModel: AppViewModel, context: Context) {
    val browseState by viewModel.browseState.collectAsState()

    if (!browseState.isOpen) return

    Dialog(
        onDismissRequest = { viewModel.dismissFileBrowser() },
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        Surface(
            modifier = Modifier
                .fillMaxWidth(0.95f)
                .fillMaxHeight(0.85f),
            shape = MaterialTheme.shapes.large,
            tonalElevation = 8.dp
        ) {
            Column(modifier = Modifier.fillMaxSize()) {
                FilenPickerTopBar(browseState, viewModel)
                Divider()
                if (browseState.isLoading) {
                    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                } else if (browseState.error != null) {
                    Box(modifier = Modifier.fillMaxSize().padding(16.dp), contentAlignment = Alignment.Center) {
                        Text(browseState.error!!, color = MaterialTheme.colorScheme.error)
                    }
                } else {
                    FilenPickerContent(browseState, viewModel, context)
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FilenPickerTopBar(state: BrowseState, viewModel: AppViewModel) {
    TopAppBar(
        title = {
            Column {
                Text("Select File", style = MaterialTheme.typography.titleMedium)
                Text(
                    state.currentPath,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
        },
        navigationIcon = {
            if (state.folderStack.isNotEmpty()) {
                IconButton(onClick = { viewModel.browseFolderUp() }) {
                    Icon(Icons.Default.ArrowBack, contentDescription = "Go up")
                }
            }
        },
        actions = {
            TextButton(onClick = { viewModel.dismissFileBrowser() }) {
                Text("Cancel")
            }
        }
    )
}

@Composable
private fun FilenPickerContent(state: BrowseState, viewModel: AppViewModel, context: Context) {
    if (state.folders.isEmpty() && state.files.isEmpty()) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("Empty folder", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }

    LazyColumn(modifier = Modifier.fillMaxSize()) {
        items(state.folders, key = { it.uuid }) { folder ->
            FolderRow(folder, viewModel)
            Divider(modifier = Modifier.padding(start = 56.dp))
        }
        items(state.files, key = { it.uuid }) { file ->
            FileRow(file, viewModel, context)
            Divider(modifier = Modifier.padding(start = 56.dp))
        }
    }
}

@Composable
private fun FolderRow(folder: FilenDirItem, viewModel: AppViewModel) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { viewModel.browseIntoFolder(folder.uuid, folder.nameDecrypted.ifEmpty { folder.name }) }
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(
            Icons.Default.Folder,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(32.dp)
        )
        Spacer(modifier = Modifier.width(16.dp))
        Text(
            folder.nameDecrypted.ifEmpty { folder.name },
            style = MaterialTheme.typography.bodyLarge,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
private fun FileRow(file: FilenDirItem, viewModel: AppViewModel, context: Context) {
    val displayName = file.nameDecrypted.ifEmpty { file.name }
    val isJson = displayName.endsWith(".json", ignoreCase = true)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { viewModel.selectFile(file, context) }
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(
            Icons.Default.Description,
            contentDescription = null,
            tint = if (isJson) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(32.dp)
        )
        Spacer(modifier = Modifier.width(16.dp))
        Column {
            Text(
                displayName,
                style = MaterialTheme.typography.bodyLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            if (isJson) {
                Text(
                    "JSON file",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.secondary
                )
            }
        }
    }
}
