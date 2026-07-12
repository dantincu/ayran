# Ayran Snip and Sketch

A Tauri + React + TypeScript app for cropping images and capturing screenshots.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Development

Desktop, with hot-reload:

```bash
npm run tauri dev
```

Android, with hot-reload (requires a connected device or running emulator):

```bash
npm run tauri android dev
```

## Building

### Desktop

```bash
npm run tauri build
```

Produces an installer/executable under `src-tauri/target/release/bundle/`.

### Android — debug build

```bash
npm run tauri android build -- --debug --target aarch64
```

Produces a debug-signed APK/AAB under `src-tauri/gen/android/app/build/outputs/`.

### Android — release build

Release builds need an upload keystore for signing. One-time setup:

```bash
keytool -genkey -v -keystore upload-keystore.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload
```

Store the resulting `.jks` file and its password(s) somewhere safe outside the repo — losing them means you can never update the app under the same signing identity again.

Create `src-tauri/gen/android/keystore.properties` (git-ignored) with:

```properties
storeFile=C:/absolute/path/to/upload-keystore.jks
storePassword=<your keystore password>
keyAlias=upload
keyPassword=<your key password>
```

To verify a keystore's contents/password later:

```bash
keytool -list -v -keystore upload-keystore.jks -alias upload
```

Then build:

```bash
npm run tauri android build -- --target aarch64 --apk --aab
```

- APK: `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`
- AAB (for Google Play): `src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab`

Before each release, bump the top-level `"version"` field in `src-tauri/tauri.conf.json` — `src-tauri/gen/android/app/tauri.properties` (versionName/versionCode) is auto-regenerated from it; don't edit that file directly.

To confirm a built APK is actually signed:

```bash
apksigner verify --print-certs src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```
