import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// ── Release signing (docs/build-and-install.md) ──
// The keystore and its password never go in git: they live in docs/private (gitignored — see CLAUDE.md's "docs/private"),
// by default at csdrive-webhost-v2/docs/private/android-release-signing.properties (CSDRIVE_ANDROID_KEYSTORE_PROPERTIES
// overrides the path, for a machine that keeps it somewhere else). A machine that hasn't made one yet just gets an
// unsigned release build (a warning below says so) rather than one silently signed with the debug key.
val releaseSigningPropsFile: File? = run {
    val override = System.getenv("CSDRIVE_ANDROID_KEYSTORE_PROPERTIES")
    val candidate = if (override != null) file(override) else File(rootProject.projectDir, "../../../../docs/private/android-release-signing.properties")
    if (candidate.exists()) candidate else null
}
val releaseSigningProps: Properties? = releaseSigningPropsFile?.let { propsFile ->
    Properties().apply { propsFile.inputStream().use { load(it) } }
}

android {
    compileSdk = 36
    namespace = "com.ayran.csdrive_webhost_tauriapp"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.ayran.csdrive_webhost_tauriapp"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        if (releaseSigningProps != null) {
            create("release") {
                val propsDir = releaseSigningPropsFile!!.parentFile
                storeFile = File(propsDir, releaseSigningProps.getProperty("storeFile"))
                storePassword = releaseSigningProps.getProperty("storePassword")
                keyAlias = releaseSigningProps.getProperty("keyAlias")
                keyPassword = releaseSigningProps.getProperty("keyPassword")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
            if (releaseSigningProps != null) {
                signingConfig = signingConfigs.getByName("release")
            } else {
                logger.warn("No release keystore found (see docs/build-and-install.md) — the release APK/AAB will be built unsigned.")
            }
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")