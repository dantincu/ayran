package com.ayran.mobilebatterylogger

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import com.ayran.mobilebatterylogger.ui.GoogleDriveLoginScreen
import com.ayran.mobilebatterylogger.ui.LoginScreen
import com.ayran.mobilebatterylogger.ui.MainScreen
import com.ayran.mobilebatterylogger.ui.theme.AppTheme

class MainActivity : ComponentActivity() {

    private val viewModel: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        viewModel.init(this)

        setContent {
            AppTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    val isLoggedIn by viewModel.isLoggedIn.collectAsState()
                    val selectedProvider by viewModel.selectedProvider.collectAsState()

                    when {
                        isLoggedIn -> MainScreen(viewModel = viewModel, context = this)
                        selectedProvider == "filen" -> LoginScreen(viewModel = viewModel, context = this)
                        else -> GoogleDriveLoginScreen(viewModel = viewModel, context = this)
                    }
                }
            }
        }
    }
}
