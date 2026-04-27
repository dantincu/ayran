package com.ayran.mobilebatterylogger

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.ayran.mobilebatterylogger.data.AppSettings
import com.ayran.mobilebatterylogger.data.SettingsRepository
import com.ayran.mobilebatterylogger.filen.FilenApi
import com.ayran.mobilebatterylogger.filen.FilenDirItem
import com.ayran.mobilebatterylogger.filen.FilenRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

sealed class LoginUiState {
    object Idle : LoginUiState()
    object Loading : LoginUiState()
    data class Error(val message: String) : LoginUiState()
}

sealed class LogOperationState {
    object Idle : LogOperationState()
    object Running : LogOperationState()
    data class Success(val message: String) : LogOperationState()
    data class Error(val message: String) : LogOperationState()
}

data class BrowseState(
    val isOpen: Boolean = false,
    val currentFolderUuid: String = "",
    val currentPath: String = "/",
    val folders: List<FilenDirItem> = emptyList(),
    val files: List<FilenDirItem> = emptyList(),
    val isLoading: Boolean = false,
    val error: String? = null,
    val folderStack: List<Pair<String, String>> = emptyList()
)

class AppViewModel : ViewModel() {

    private val _settings = MutableStateFlow(AppSettings())
    val settings: StateFlow<AppSettings> = _settings.asStateFlow()

    private val _isLoggedIn = MutableStateFlow(false)
    val isLoggedIn: StateFlow<Boolean> = _isLoggedIn.asStateFlow()

    private val _loginState = MutableStateFlow<LoginUiState>(LoginUiState.Idle)
    val loginState: StateFlow<LoginUiState> = _loginState.asStateFlow()

    private val _logState = MutableStateFlow<LogOperationState>(LogOperationState.Idle)
    val logState: StateFlow<LogOperationState> = _logState.asStateFlow()

    private val _browseState = MutableStateFlow(BrowseState())
    val browseState: StateFlow<BrowseState> = _browseState.asStateFlow()

    private lateinit var settingsRepo: SettingsRepository
    private val filenRepo = FilenRepository()

    fun init(context: Context) {
        settingsRepo = SettingsRepository(context)
        val loaded = settingsRepo.load()
        _settings.value = loaded
        _isLoggedIn.value = loaded.apiKey.isNotEmpty()
    }

    fun loginWithPassword(context: Context, email: String, password: String) {
        _loginState.value = LoginUiState.Loading
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val (apiKey, masterKeys, _) = filenRepo.authenticate(email, password)
                val updated = _settings.value.copy(
                    apiKey = apiKey,
                    masterKeys = masterKeys,
                    email = email
                )
                settingsRepo.save(updated)
                _settings.value = updated
                _isLoggedIn.value = true
                _loginState.value = LoginUiState.Idle
            } catch (e: Exception) {
                _loginState.value = LoginUiState.Error(e.message ?: "Login failed")
            }
        }
    }

    fun loginWithApiKey(context: Context, apiKey: String) {
        _loginState.value = LoginUiState.Loading
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val valid = filenRepo.validateApiKeyOnly(apiKey)
                if (!valid) throw Exception("Invalid API key")
                val updated = _settings.value.copy(apiKey = apiKey, masterKeys = emptyList())
                settingsRepo.save(updated)
                _settings.value = updated
                _isLoggedIn.value = true
                _loginState.value = LoginUiState.Idle
            } catch (e: Exception) {
                _loginState.value = LoginUiState.Error(e.message ?: "Invalid API key")
            }
        }
    }

    fun logout(context: Context) {
        settingsRepo.clear()
        _settings.value = AppSettings()
        _isLoggedIn.value = false
        _loginState.value = LoginUiState.Idle
    }

    fun updateMaxLogEntries(value: Int) {
        val updated = _settings.value.copy(maxLogEntries = value)
        _settings.value = updated
        if (::settingsRepo.isInitialized) settingsRepo.save(updated)
    }

    fun logBatteryLevel(context: Context) {
        _logState.value = LogOperationState.Running
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val s = _settings.value
                if (s.apiKey.isEmpty()) throw Exception("Not logged in")
                if (s.fileUuid.isEmpty() && s.filePath.isEmpty()) throw Exception("No log file selected")

                val batteryLevel = getBatteryLevel(context)
                val fileName = s.filePath.substringAfterLast("/").ifEmpty { "battery_log.json" }
                val parentUuid = s.parentFolderUuid.ifEmpty { filenRepo.getRootFolderUuid(s.apiKey) }

                val newUuid = filenRepo.logBattery(
                    s.apiKey, s.masterKeys, s.fileUuid, parentUuid,
                    fileName, batteryLevel, s.maxLogEntries
                )

                val updated = s.copy(fileUuid = newUuid)
                _settings.value = updated
                settingsRepo.save(updated)
                _logState.value = LogOperationState.Success("Logged battery at $batteryLevel%")
            } catch (e: Exception) {
                _logState.value = LogOperationState.Error(e.message ?: "Logging failed")
            }
        }
    }

    fun openFileBrowser(context: Context) {
        viewModelScope.launch(Dispatchers.IO) {
            _browseState.value = BrowseState(isOpen = true, isLoading = true)
            try {
                val s = _settings.value
                val rootUuid = filenRepo.getRootFolderUuid(s.apiKey)
                loadFolder(rootUuid, "/", emptyList())
            } catch (e: Exception) {
                _browseState.value = _browseState.value.copy(isLoading = false, error = e.message)
            }
        }
    }

    fun browseIntoFolder(uuid: String, name: String) {
        viewModelScope.launch(Dispatchers.IO) {
            val current = _browseState.value
            val newStack = current.folderStack + Pair(current.currentFolderUuid, current.currentPath)
            val newPath = if (current.currentPath == "/") "/$name" else "${current.currentPath}/$name"
            loadFolder(uuid, newPath, newStack)
        }
    }

    fun browseFolderUp() {
        viewModelScope.launch(Dispatchers.IO) {
            val current = _browseState.value
            if (current.folderStack.isEmpty()) return@launch
            val (prevUuid, prevPath) = current.folderStack.last()
            val newStack = current.folderStack.dropLast(1)
            loadFolder(prevUuid, prevPath, newStack)
        }
    }

    private suspend fun loadFolder(uuid: String, path: String, stack: List<Pair<String, String>>) {
        _browseState.value = _browseState.value.copy(isLoading = true, error = null)
        try {
            val s = _settings.value
            val (folders, files) = filenRepo.listDirectory(s.apiKey, s.masterKeys, uuid)
            _browseState.value = BrowseState(
                isOpen = true,
                currentFolderUuid = uuid,
                currentPath = path,
                folders = folders,
                files = files,
                isLoading = false,
                folderStack = stack
            )
        } catch (e: Exception) {
            _browseState.value = _browseState.value.copy(isLoading = false, error = e.message)
        }
    }

    fun selectFile(file: FilenDirItem, context: Context) {
        val current = _browseState.value
        val displayName = file.nameDecrypted.ifEmpty { file.name }
        val fullPath = if (current.currentPath == "/") "/$displayName" else "${current.currentPath}/$displayName"
        val updated = _settings.value.copy(
            fileUuid = file.uuid,
            filePath = fullPath,
            parentFolderUuid = current.currentFolderUuid
        )
        _settings.value = updated
        settingsRepo.save(updated)
        dismissFileBrowser()
    }

    fun dismissFileBrowser() {
        _browseState.value = BrowseState(isOpen = false)
    }

    fun clearLogOperation() {
        _logState.value = LogOperationState.Idle
    }

    private fun getBatteryLevel(context: Context): Int {
        val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        return if (level >= 0 && scale > 0) (level * 100 / scale) else -1
    }
}
