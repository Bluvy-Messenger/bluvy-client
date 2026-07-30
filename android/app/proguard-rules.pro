# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

-dontwarn com.google.errorprone.annotations.CanIgnoreReturnValue
-dontwarn com.google.errorprone.annotations.CheckReturnValue
-dontwarn com.google.errorprone.annotations.Immutable
-dontwarn com.google.errorprone.annotations.RestrictedApi
-dontwarn javax.annotation.Nullable
-dontwarn javax.annotation.concurrent.GuardedBy

# Preserve line numbers for debugging crash stack traces
-keepattributes SourceFile,LineNumberTable

# Capacitor Core & Bridge Reflection
-keep class com.getcapacitor.** { *; }
-keepclasseswithmembers class * {
    @com.getcapacitor.PluginMethod <methods>;
    @com.getcapacitor.annotation.CapacitorPlugin <methods>;
}

# Capacitor Official Plugins (App, Push, Browser, Preferences, Device, etc.)
-keep class com.capacitor.plugins.** { *; }

# Capacitor Community SQLite & SQLCipher
-keep class com.capacitorcommunity.sqlite.** { *; }
-keep class net.sqlcipher.** { *; }
-keep class net.sqlcipher.database.** { *; }

# Aparajita Secure Storage
-keep class com.aparajita.capacitor.securestorage.** { *; }

# Capawesome Edge-to-Edge Support
-keep class io.capawesome.capacitor.** { *; }

