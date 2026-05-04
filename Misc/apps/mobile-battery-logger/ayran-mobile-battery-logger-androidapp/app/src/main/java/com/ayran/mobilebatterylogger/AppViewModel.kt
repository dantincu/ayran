package com.ayran.mobilebatterylogger

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.ayran.mobilebatterylogger.data.AppSettings
import com.ayran.mobilebatterylogger.data.SettingsRepository
import com.ayran.mobilebatterylogger.filen.FilenDirItem
import com.ayran.mobilebatterylogger.filen.FilenRepository
import com.ayran.mobilebatterylogger.googledrive.GoogleDriveRepository
import com.ayran.mobilebatterylogger.storage.StorageProviderConfig
import com.google.android.gms.auth.GoogleAuthUtil
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.Scope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

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

    private val _selectedProvider = MutableStateFlow("")
    val selectedProvider: StateFlow<String> = _selectedProvider.asStateFlow()

    private lateinit var settingsRepo: SettingsRepository
    private lateinit var appContext: Context
    private val filenRepo = FilenRepository()
    private val googleDriveRepo = GoogleDriveRepository()

    fun init(context: Context) {
        appContext = context.applicationContext
        settingsRepo = SettingsRepository(context)
        val loaded = settingsRepo.load()

        val provider = loaded.selectedProvider.ifEmpty {
            StorageProviderConfig.enabledProviders.firstOrNull()?.id ?: ""
        }
        val settings = if (loaded.selectedProvider != provider) loaded.copy(selectedProvider = provider) else loaded

        _settings.value = settings
        _selectedProvider.value = provider
        _isLoggedIn.value = when (provider) {
            "filen" -> settings.apiKey.isNotEmpty()
            "google_drive" -> GoogleSignIn.getLastSignedInAccount(context) != null
            else -> false
        }
    }

    // --- Filen.io auth ---

    fun loginWithPassword(context: Context, email: String, password: String, twoFactorCode: String = "") {
        _loginState.value = LoginUiState.Loading
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val (apiKey, masterKeys, _) = filenRepo.authenticate(email, password, twoFactorCode)
                val updated = _settings.value.copy(apiKey = apiKey, masterKeys = masterKeys, email = email)
                settingsRepo.save(updated)
                _settings.value = updated
                _isLoggedIn.value = true
                _loginState.value = LoginUiState.Idle
            } catch (e: Exception) {
                _loginState.value = LoginUiState.Error(e.message ?: "Login failed")
            }
        }
    }

    // --- Google Drive auth ---

    fun getGoogleSignInIntent(context: Context): Intent {
        val gso = GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
            .requestEmail()
            .requestScopes(Scope("https://www.googleapis.com/auth/drive"))
            .build()
        return GoogleSignIn.getClient(context, gso).signInIntent
    }

    fun handleGoogleSignInResult(data: Intent?, context: Context) {
        _loginState.value = LoginUiState.Loading
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val account = GoogleSignIn.getSignedInAccountFromIntent(data)
                    .getResult(ApiException::class.java)
                val updated = _settings.value.copy(email = account.email ?: "")
                settingsRepo.save(updated)
                _settings.value = updated
                _isLoggedIn.value = true
                _loginState.value = LoginUiState.Idle
            } catch (e: ApiException) {
                _loginState.value = LoginUiState.Error("Google Sign-In failed: ${e.statusCode}")
            }
        }
    }

    fun onGoogleSignInCancelled() {
        _loginState.value = LoginUiState.Idle
    }

    // --- Shared ---

    fun logout(context: Context) {
        if (_selectedProvider.value == "google_drive") {
            GoogleSignIn.getClient(context, GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN).build()).signOut()
        }
        settingsRepo.clear()
        _settings.value = AppSettings(selectedProvider = _selectedProvider.value)
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
                val batteryLevel = getBatteryLevel(context)
                val fileName = s.filePath.substringAfterLast("/").ifEmpty { "battery_log.json" }

                val newUuid = when (s.selectedProvider) {
                    "filen" -> {
                        if (s.apiKey.isEmpty()) throw Exception("Not logged in")
                        if (s.fileUuid.isEmpty() && s.filePath.isEmpty()) throw Exception("No log file selected")
                        val parentUuid = s.parentFolderUuid.ifEmpty { filenRepo.getRootFolderUuid(s.apiKey) }
                        filenRepo.logBattery(s.apiKey, s.masterKeys, s.fileUuid, parentUuid, fileName, batteryLevel, s.maxLogEntries)
                    }
                    "google_drive" -> {
                        if (s.filePath.isEmpty()) throw Exception("No log file selected")
                        val token = getGoogleAccessToken()
                        val parentId = s.parentFolderUuid.ifEmpty { "root" }
                        googleDriveRepo.logBattery(token, s.fileUuid, parentId, fileName, batteryLevel, s.maxLogEntries)
                    }
                    else -> throw Exception("Unknown storage provider")
                }

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
                val rootId = when (_settings.value.selectedProvider) {
                    "filen" -> filenRepo.getRootFolderUuid(_settings.value.apiKey)
                    "google_drive" -> "root"
                    else -> throw Exception("Unknown provider")
                }
                loadFolder(rootId, "/", emptyList())
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
            loadFolder(prevUuid, prevPath, current.folderStack.dropLast(1))
        }
    }

    private suspend fun loadFolder(uuid: String, path: String, stack: List<Pair<String, String>>) {
        _browseState.value = _browseState.value.copy(isLoading = true, error = null)
        try {
            val s = _settings.value
            val (folders, files) = when (s.selectedProvider) {
                "filen" -> filenRepo.listDirectory(s.apiKey, s.masterKeys, uuid)
                "google_drive" -> googleDriveRepo.listFolder(getGoogleAccessToken(), uuid)
                else -> throw Exception("Unknown provider")
            }
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

    private fun getGoogleAccessToken(): String {
        val account = GoogleSignIn.getLastSignedInAccount(appContext)
            ?: throw Exception("Not signed in with Google")
        return GoogleAuthUtil.getToken(
            appContext,
            account.account!!,
            "oauth2:https://www.googleapis.com/auth/drive"
        )
    }

    private fun getBatteryLevel(context: Context): Int {
        val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        return if (level >= 0 && scale > 0) (level * 100 / scale) else -1
    }
}
