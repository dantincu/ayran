# Building a release and installing it

How to build **Ayran CsDrive WebHost** in release mode — for Windows and for Android — and put the result on a real machine or
device. This is about *release* builds meant to be used for real; for day-to-day development see "Building and running" in
[CLAUDE.md](../CLAUDE.md) and, on Android, its "Building" section.

**Read this first if the machine you are building on is also the one you use the app on for real:** a release build reads and
writes the very same production data a development run would (same `DEFAULT_DATA_FOLDER`, same custom-data-folder pointer, same
keychain entries — building or installing a new version never isolates anything). That is expected and is what upgrading the app
normally means — the point of a release build *is* to become (or replace) the copy you actually use. What must never happen by
accident is running a *test* or a *debug* session un-isolated against that same data; see "Careful: development runs can reach
production data" in the [repo README](../README.md) before you do anything but build and install. Building and installing a
release, on its own, does not touch `user/`, `admin/data.db` or `files/` — an installer or an APK only replaces the *program*;
whatever data folder it finds (the default one, or a custom one a previous install pointed at) is exactly what it opens next time
it runs.

## Windows

### Prerequisites

- The Rust toolchain (`rustup`), matching what `cargo build` already uses for this project.
- Node.js and `npm` (`npm install` once, inside `csdrive-webhost-tauriapp/`, if you have not already).
- The Tauri CLI: `cargo install tauri-cli --version "^2"` (a one-time, global `cargo install`; this project has no
  `@tauri-apps/cli` npm dependency, so `cargo tauri …` is what runs it, not `npm run tauri …`).
- Nothing else is required by hand: the Windows bundler (NSIS and WiX/MSI) downloads and caches its own `makensis`/WiX tools the
  first time it runs, and needs no separate install.
- **No code-signing certificate is set up for this project.** The installer and the app it installs will be unsigned. That is
  fine for personal use, but:
  - **Windows SmartScreen / Microsoft Defender will warn** ("Windows protected your PC") the first time the installer (or the
    app itself) runs on a machine that has not seen it before. Click **More info → Run anyway**. This is expected for an
    unsigned build and is not a sign anything is wrong.
  - If Windows also *blocks* the downloaded/copied file outright (a padlock-like "blocked" note in its Properties dialog),
    right-click the file → **Properties** → tick **Unblock** → OK, then run it.
  - If you ever want a signed build (no warnings), that needs a code-signing certificate and `signtool`, configured under
    `bundle.windows.certificateThumbprint` (or `bundle.windows.sign`/`SIGNTOOL_PATH`+`TAURI_SIGNING_PRIVATE_KEY`-style env vars,
    depending on the certificate type) in `tauri.conf.json` — not set up here.

### Building

```
cd csdrive-webhost-tauriapp
npm install            # only if you have not already
cargo tauri build
```

This runs `npm run build` first (`beforeBuildCommand`, which is `tsc -b && vite build`), embeds the built admin-app into the
binary, compiles the Rust backend in release mode, and then bundles it. It takes a few minutes; most of that is the Rust
compile. Because `bundle.targets` is `"all"`, it produces **both** an NSIS installer and an MSI, plus the bare `.exe`:

```
csdrive-webhost-tauriapp/src-tauri/target/release/csdrive-webhost-tauriapp.exe                              (the bare binary)
csdrive-webhost-tauriapp/src-tauri/target/release/bundle/nsis/Ayran CsDrive WebHost_<version>_x64-setup.exe  (installer)
csdrive-webhost-tauriapp/src-tauri/target/release/bundle/msi/Ayran CsDrive WebHost_<version>_x64_en-US.msi   (installer)
```

(`<version>` is the `version` field of `tauri.conf.json`.) Either installer does the same job; NSIS is the smaller, more
common choice and is what the rest of this section uses. The bare `.exe` also runs on its own (useful for a quick check) but
that is *not* an install: it adds no Start Menu entry, no uninstaller, and no "Apps & features" listing.

### Installing

**Interactively:** double-click the `…-setup.exe` and follow it. It installs per-user by default (no administrator prompt),
under `%LOCALAPPDATA%\Programs\Ayran CsDrive WebHost` or similar, and adds a Start Menu shortcut and an uninstaller.

**Silently** (no dialogs — useful for a repeat install/upgrade you trust): run the same installer with `/S`:

```
& "csdrive-webhost-tauriapp\src-tauri\target\release\bundle\nsis\Ayran CsDrive WebHost_<version>_x64-setup.exe" /S
```

If the app is currently running, close it first (the installer cannot replace files that are in use).

**Upgrading:** just run the newer installer the same way — NSIS installs over the previous copy in place. Nothing under the
data folder is touched by this; only the program files and the Start Menu entry are replaced.

**Uninstalling:** Windows Settings → **Apps** → find "Ayran CsDrive WebHost" → **Uninstall** — or run the `uninstall.exe` left
in the install folder. Uninstalling removes the program only; the data folder (and a custom data folder it may point at) is left
alone, exactly as "Delete app data" inside the app is the only thing that removes that.

## Android

### Prerequisites

Same as the emulator/debug workflow in CLAUDE.md's "Android" section: `ANDROID_HOME`, `NDK_HOME`, and **`JAVA_HOME` set to a
JDK 17** (Android Studio's bundled newer JDK breaks Gradle here) — on this machine:

```
$env:ANDROID_HOME = 'C:\Users\<you>\AppData\Local\Android\Sdk'
$env:NDK_HOME      = 'C:\Users\<you>\AppData\Local\Android\Sdk\ndk\<installed version>'
$env:JAVA_HOME     = 'C:\Users\<you>\AppData\Local\jdks\jdk-17...'
$env:PATH          = "$env:JAVA_HOME\bin;$env:PATH"
```

A phone (or emulator) connected and visible to `adb devices`, with **USB debugging** enabled on the phone (Settings →
About phone → tap "Build number" seven times → Developer options → USB debugging) if you are installing on a real device.

### A release build needs a signing key (one-time setup)

Android refuses to install (or update) an app whose APK is not signed, and a *release* build type is not signed by the
throwaway debug key debug builds use. This project keeps that key **out of git**, in `docs/private` — the same gitignored
folder CLAUDE.md's "docs/private" describes for other machine-specific secrets — so it is set up **once per machine** you build
releases on, exactly like `docs/private/filen.md` is.

**If `docs/private/android-release-signing.properties` and the keystore it names already exist on this machine, skip to
"Building" below** — this has already been done.

**To set it up on a new machine:**

1. Generate a keystore (needs a JDK's `keytool`, e.g. the JDK 17 above):

   ```
   & "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -v `
     -keystore docs\private\android-release.keystore `
     -alias csdrive-webhost `
     -keyalg RSA -keysize 2048 -validity 10957 `
     -dname "CN=Ayran CsDrive WebHost, OU=Ayran, O=Ayran, C=US"
   ```

   It will ask for a password (used for both the keystore and the key — modern `keytool` only supports one password per PKCS12
   keystore, which is the default type now). **Keep that password somewhere you will not lose it**: there is no way to
   re-sign future updates of an already-installed app with a *different* key — Android treats that as a different app and
   refuses the update (uninstalling the old one first is the only way around it, which loses that app's data).

2. Record it in `docs/private/android-release-signing.properties` (copy `docs/private-template/android-release-signing.properties`
   and fill in the real password):

   ```
   storeFile=android-release.keystore
   storePassword=<the password from step 1>
   keyAlias=csdrive-webhost
   keyPassword=<the same password>
   ```

Both files are under `docs/private`, which `docs/.gitignore` excludes — they will never be committed. `build.gradle.kts` reads
this file automatically (by a path relative to the Android Gradle project, or `CSDRIVE_ANDROID_KEYSTORE_PROPERTIES` if you keep
it somewhere else) and signs the **release** build type with it; if the file is missing, the release build still succeeds but
produces an **unsigned** APK/AAB (Gradle prints a warning saying so) rather than silently using the debug key.

### Building

For installing on a real phone, restrict the Rust compile to just the architecture it needs (much faster than compiling for
every architecture, which the debug/emulator workflow does) — a current phone is `aarch64` (`arm64-v8a`):

```
cd csdrive-webhost-tauriapp
cargo tauri android build -t aarch64 --apk
```

This runs the frontend build, compiles the Rust backend in release mode for `aarch64-linux-android`, and produces a signed
(if the keystore from above is present) release APK. **It is still named `app-universal-release.apk`** — "universal" here
names the one Gradle build variant that exists (it just happens to contain only one architecture's native library, because
that is the only one `-t aarch64` compiled); passing `--split-per-abi` as well would instead produce one differently-named APK
per architecture, which is not needed for installing on one known phone:

```
csdrive-webhost-tauriapp/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

(For an emulator on this machine instead — which is `x86_64` — use `-t x86_64` instead of `-t aarch64`; the debug/testing
workflow in CLAUDE.md keeps building the unsigned, all-architectures **debug** APK with `--debug --target x86_64 --apk`
(`apk/universal/debug/app-universal-debug.apk`), which is a separate, smaller, unminified build meant for the emulator and
does not need a keystore at all.)

Verifying it really got signed with the release key (rather than left unsigned) needs `apksigner`, not `jarsigner` — APKs are
signed with APK Signature Scheme v2/v3, which `jarsigner -verify` cannot see and will misreport as "jar is unsigned":

```
& "$env:ANDROID_HOME\build-tools\<installed version>\apksigner.bat" verify --verbose --print-certs "csdrive-webhost-tauriapp\src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release.apk"
```

— look for `Verifies` and `Verified using v2 scheme: true`, and that the certificate DN matches the one `keytool` was given
when the keystore was made.

### Installing

With the phone connected and authorized (`adb devices` lists it as `device`, not `unauthorized`):

```
adb install -r "csdrive-webhost-tauriapp\src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release.apk"
```

`-r` reinstalls over an existing copy (keeping its data) if one is already on the phone — the ordinary way to upgrade. If the
phone ever had a *debug* build of the app installed, uninstall that first (`adb uninstall com.ayran.csdrive_webhost_tauriapp`):
Android treats a debug build and this release build as signed by different keys, so it refuses to install one over the other,
and the message is easy to misread as a general failure rather than "remove the other one first".

To remove it later: `adb uninstall com.ayran.csdrive_webhost_tauriapp`, or uninstall it from the phone's home screen /
Settings → Apps like any other app.

### A note on Google Play

None of the above targets the Play Store — it is a self-signed key for sideloading, which is what this whole document is
about. **CLAUDE.md's "Picked folders" already notes that the "All files access" permission the folder picker needs is
Play-restricted**; if this app is ever submitted to Play, that (and Play's own signing-key requirements, which differ from
plain sideloading) would need separate handling. Nothing here changes that.
