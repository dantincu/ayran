# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# **Every class of this app's own Kotlin code, kept whole.** Two things reach these classes in ways R8's static analysis
# can't see, so it would otherwise remove or rename them out from under the calls that need them by name:
#  - Rust calls into `SecureKey`, `DeviceFiles`, `ExternalSites` and `FolderPicker` by reflection over JNI
#    (`android_jni::helper_class` + `call_static_method`, by fully-qualified class name and method signature — see those
#    Rust modules and android_jni.rs) — nothing in the Kotlin/Java bytecode itself calls them, so a normal reachability
#    analysis sees them as unused.
#  - The WebView's own JS bridge looks up `@JavascriptInterface` methods on `MainActivity`'s `SafeAreaBridge`/`SplashBridge`
#    and `WindowActivity`'s `Bridge` by reflection too (see the second rule below, kept for every class as the standard,
#    defensive form of this rule — this one already covers our own package on its own).
# A `NoSuchMethodError`/`ClassNotFoundException` from any of these — surfacing in Rust as "Android: Java exception was
# thrown" (`android_jni.rs`) — is what missing coverage here looks like; keeping the whole package removes the risk instead
# of chasing it class by class as new helpers are added. The package is our own thin glue code, not a third party
# library, so there is nothing worth minifying here in the first place.
-keep class com.ayran.csdrive_webhost_tauriapp.** { *; }

# The standard rule for a WebView's JavaScript interface (this project's version of the commented-out template Android
# Studio generates here): kept for every class, not just our own package, as the usual defensive form of it.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
