plugins {
    id("com.android.library")
    id("com.ncorti.ktfmt.gradle")
    id("dev.detekt")
}

ktfmt { kotlinLangStyle() }

detekt {
    buildUponDefaultConfig.set(true)
    config.setFrom(rootProject.file("detekt.yml"))
}

kotlin { compilerOptions { allWarningsAsErrors.set(true) } }

android {
    namespace = "page.dial.data"
    compileSdk = 37
    buildToolsVersion = "36.0.0"
    defaultConfig {
        minSdk = 29
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
    testOptions {
        unitTests.isIncludeAndroidResources = true
        unitTests.all {
            it.systemProperty(
                "phonebook.fixture",
                rootProject
                    .file("../ios/Tests/PhonebookKitTests/DirectoryContract.json")
                    .absolutePath,
            )
        }
    }
    lint {
        abortOnError = true
        warningsAsErrors = true
    }
}

dependencies {
    api(project(":core"))
    implementation("org.brotli:dec:0.1.2")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.17")
    testImplementation("androidx.test:core:1.7.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
}
