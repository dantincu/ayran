# Ayran Quick Notes

A markdown-based quick notes app built with [Tauri](https://tauri.app) (Rust) + React + TypeScript, storing everything locally in the browser's IndexedDB. Runs as a desktop app and as an Android app from the same codebase. See [CLAUDE.md](CLAUDE.md) for the full feature spec.

## Desktop development

```bash
npm install
npm run tauri dev      # desktop app with hot reload
npm run build           # typecheck + build the frontend only
```

## Android development

Android tooling is finicky to set up correctly on Windows. The steps below capture everything that's actually needed, based on what tripped this project up the first time.

### One-time environment setup

1. **Android Studio + SDK** — install normally. Note the SDK location (usually `%LOCALAPPDATA%\Android\Sdk`).
2. **NDK** — install via `sdkmanager`, e.g.:
   ```powershell
   & "$env:LOCALAPPDATA\Android\Sdk\cmdline-tools\bin\sdkmanager.bat" "ndk;29.0.13846066" --sdk_root="$env:LOCALAPPDATA\Android\Sdk"
   ```
   If it refuses due to an unaccepted license, run `sdkmanager --licenses` interactively (in a real terminal, not piped) and accept them, or place the known `android-sdk-preview-license` hash directly in `%LOCALAPPDATA%\Android\Sdk\licenses\`.
3. **A JDK 17** (not Android Studio's bundled JBR, which may be JDK 25+ and is **not** supported by the Gradle version Tauri's Android template pins — this produces `Unsupported class file major version 69`). Download a standalone Temurin JDK 17 and note its path, e.g. `C:\jdks\jdk-17.x.x+x`.
4. **Windows Developer Mode** — required so Tauri can create the symlink from the compiled Rust `.so` into the Android project's `jniLibs` dir. Enable via Settings → Privacy & security → For developers → Developer Mode, or:
   ```powershell
   reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock" /t REG_DWORD /f /v "AllowDevelopmentWithoutDevLicense" /d "1"
   ```
5. **Generate the Android project** (first time only):
   ```powershell
   $env:JAVA_HOME = "C:\jdks\jdk-17.x.x+x"
   npx tauri android init
   ```

### Running

Always set `JAVA_HOME` to the standalone JDK 17 before running Android commands (Gradle needs it; the NDK/Rust toolchain doesn't care):

```powershell
$env:JAVA_HOME = "C:\jdks\jdk-17.x.x+x"
npm run tauri android dev
```

This builds the Rust code for the connected device's ABI, assembles the APK via Gradle, installs it, and launches it with hot reload wired to the Vite dev server. **A device must already be connected/booted before you run this** — it does not launch an emulator for you.

If more than one device/emulator is connected at once, `tauri android dev` may get confused about which one to target — disconnect/stop the others, or pass a device name as a positional arg (`npm run tauri android dev -- <device-name>`, see `npx tauri android dev --help`).

#### On a physical device

1. Enable Developer Options + USB debugging on the phone, connect via USB, accept the RSA fingerprint prompt.
2. Confirm it shows up: `adb devices -l`.
3. For hot reload to work, the phone must be on the **same Wi-Fi network** as this machine — Tauri serves the dev bundle over LAN, not through the USB cable.
4. Run the command above.

#### On an emulator

1. Create an AVD once, e.g.:
   ```powershell
   $sdkmanager = "$env:LOCALAPPDATA\Android\Sdk\cmdline-tools\bin\sdkmanager.bat"
   & $sdkmanager "system-images;android-34;google_apis;x86_64" --sdk_root="$env:LOCALAPPDATA\Android\Sdk"
   $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
   & "$env:LOCALAPPDATA\Android\Sdk\cmdline-tools\bin\avdmanager.bat" create avd --name my_avd --package "system-images;android-34;google_apis;x86_64" --device "pixel_7"
   ```
   Use **API 34**, not the newest preview API level — a newer preview image (API 37) had a broken graphics stack in testing (crashed on screen capture, stuck boot splash) regardless of GPU/software rendering mode. API 34 is stable and well-tested.
2. If the AVD fails to boot with `Cannot find AVD system path`, its `config.ini` has a bad relative `image.sysdir.1` path (a known `sdkmanager`/`avdmanager` quirk on Windows) — edit `%USERPROFILE%\.android\avd\<name>.avd\config.ini` and set `image.sysdir.1` to the full absolute path of the system image directory.
3. The emulator needs hardware acceleration. If you see `x86_64 emulation currently requires hardware acceleration!`, enable Windows Hypervisor Platform (as admin, then reboot):
   ```powershell
   Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All
   ```
4. Launch it before running the dev command:
   ```powershell
   & "$env:LOCALAPPDATA\Android\Sdk\emulator\emulator.exe" -avd my_avd
   ```
   A first cold boot can take several minutes and may include one internal restart — this is normal.

### Building a release APK

`tauri android dev` always installs a **debug** build wired to the Vite dev server — it needs that server running and isn't meant for actual use. For a standalone installable app, build a signed release APK instead.

1. **One-time: create a local signing keystore.** Release builds must be signed; there's no default keystore the way debug builds get one automatically. Generate one (keep `JAVA_HOME` set to the JDK 17 from above) and save its passwords into `keystore.properties` next to it — both are already gitignored, never commit them:
   ```powershell
   $env:JAVA_HOME = "C:\jdks\jdk-17.x.x+x"
   $pass = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 24 | % {[char]$_})
   & "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -v `
     -keystore "src-tauri\gen\android\app\quicknotes-release.keystore" `
     -alias quicknotes -keyalg RSA -keysize 2048 -validity 10000 `
     -storepass $pass -keypass $pass `
     -dname "CN=Ayran Quick Notes, OU=Dev, O=Ayran, C=US"
   @"
   storeFile=quicknotes-release.keystore
   storePassword=$pass
   keyAlias=quicknotes
   keyPassword=$pass
   "@ | Out-File -Encoding utf8 "src-tauri\gen\android\app\keystore.properties"
   ```
   `app/build.gradle.kts` picks this up automatically when present (see the `keystoreProperties`/`signingConfigs` block) and signs the `release` build type with it. Without it, `release` builds still succeed but produce an **unsigned** APK that `adb install` will refuse to install.

2. **Build it:**
   ```powershell
   $env:JAVA_HOME = "C:\jdks\jdk-17.x.x+x"
   npm run tauri android build -- --target aarch64 --apk
   ```
   Drop `--target aarch64` to build for all ABIs (slower, produces one APK per architecture instead of one universal APK). The output lands at:
   ```
   src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release.apk
   ```

3. **Verify it's actually signed** (`keytool -printcert -jarfile` reports "Not a signed jar file" even on validly-signed APKs — it doesn't understand the v2/v3 signature scheme Android Gradle Plugin uses by default, so use `apksigner` instead):
   ```powershell
   & "$env:LOCALAPPDATA\Android\Sdk\build-tools\36.0.0\apksigner.bat" verify --print-certs "src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release.apk"
   ```

4. **Install it.** The release build's application ID has no `.debug` suffix (`com.ayran.quicknotes` vs. `com.ayran.quicknotes.debug`), so it's a separate app from any debug install — installing one doesn't overwrite the other, and their note data doesn't carry over between them. If you were previously running the debug build and want just the release one going forward:
   ```powershell
   adb uninstall com.ayran.quicknotes.debug
   adb install "src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release.apk"
   ```

### Notes on navigating the running app

The app doesn't use the browser History API, so the phone's system/hardware Back button exits the app directly rather than stepping back through in-app screens — only the app's own in-app back arrow navigates between the editor and the notes list.
