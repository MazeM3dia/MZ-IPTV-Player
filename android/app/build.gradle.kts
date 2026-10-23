import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing key, if this machine has one: android/keystore.properties
// (git-ignored; see keystore.properties.example). Without it, release builds
// fall back to the debug key so anyone can still build from source.
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.mazem3dia.iptv"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.mazem3dia.iptv"
        minSdk = 21
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    signingConfigs {
        if (keystoreProps.isNotEmpty()) {
            create("release") {
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    // The UI is the shared web page: ../../web/index.html is packaged as
    // assets/index.html, so the browser build and the app never drift apart.
    sourceSets["main"].assets.srcDirs("../../web")
}

dependencies {
    val media3 = "1.5.1"
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.media3:media3-exoplayer:$media3")
    implementation("androidx.media3:media3-exoplayer-hls:$media3")
    implementation("androidx.media3:media3-ui:$media3")
}

// APK file names: MZ-IPTV-Player-<version>-debug.apk / -release.apk
base.archivesName = "MZ-IPTV-Player-${android.defaultConfig.versionName}"
