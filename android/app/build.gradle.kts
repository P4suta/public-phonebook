import org.gradle.api.file.DirectoryProperty
import org.gradle.api.tasks.OutputDirectory

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.ncorti.ktfmt.gradle")
    id("dev.detekt")
    id("org.cyclonedx.bom")
}

ktfmt { kotlinLangStyle() }

detekt {
    debug.set(providers.gradleProperty("analysisDiagnostics").isPresent)
    buildUponDefaultConfig.set(true)
    config.setFrom(rootProject.file("detekt.yml"))
}

tasks.named<org.cyclonedx.gradle.CyclonedxDirectTask>("cyclonedxDirectBom") {
    includeConfigs.set(listOf("productionReleaseRuntimeClasspath"))
    projectType.set(org.cyclonedx.model.Component.Type.APPLICATION)
    componentName.set("Public Phonebook")
    componentVersion.set("1.0.0")
}

afterEvaluate {
    tasks.named<dev.detekt.gradle.Detekt>("detektVerificationDebug") {
        val generated = tasks.named<JavaCompile>("compileVerificationDebugJavaWithJavac")
        dependsOn(generated)
        val compileDependencies = classpath.files.toList()
        classpath.setFrom(compileDependencies)
        classpath.from(generated.flatMap { it.destinationDirectory })
    }
}

kotlin { compilerOptions { allWarningsAsErrors.set(true) } }

android {
    namespace = "page.dial.publicphonebook"
    compileSdk = 37
    buildToolsVersion = "36.0.0"
    defaultConfig {
        applicationId = "page.dial.publicphonebook"
        minSdk = 29
        //noinspection OldTargetApi
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("boolean", "QA_ENABLED", "false")
        buildConfigField("boolean", "SYNC_ENABLED", "true")
    }
    flavorDimensions += "environment"
    productFlavors {
        create("production") {
            dimension = "environment"
            buildConfigField("String", "ORIGIN", "\"https://www.dial.page\"")
        }
        create("verification") {
            dimension = "environment"
            applicationIdSuffix = ".verification"
            buildConfigField("String", "ORIGIN", "\"https://www.dial.page\"")
            buildConfigField("boolean", "QA_ENABLED", "true")
        }
        create("development") {
            dimension = "environment"
            applicationIdSuffix = ".development"
            buildConfigField("String", "ORIGIN", "\"https://www.dial.page\"")
            buildConfigField("boolean", "SYNC_ENABLED", "false")
        }
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    testOptions { unitTests.isIncludeAndroidResources = true }
    androidResources { noCompress += "br" }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
    lint {
        abortOnError = true
        warningsAsErrors = true
    }
    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }
    providers.environmentVariable("PHONEBOOK_ANDROID_KEYSTORE").orNull?.let { location ->
        val upload =
            signingConfigs.create("upload") {
                storeFile = file(location)
                storeType = "PKCS12"
                keyAlias = providers.environmentVariable("PHONEBOOK_ANDROID_KEY_ALIAS").get()
                storePassword =
                    providers.environmentVariable("PHONEBOOK_ANDROID_STORE_PASSWORD").get()
                keyPassword = providers.environmentVariable("PHONEBOOK_ANDROID_KEY_PASSWORD").get()
            }
        buildTypes.getByName("release").signingConfig = upload
    }
}

abstract class DirectoryAssets : Exec() {
    @get:OutputDirectory abstract val contractDirectory: DirectoryProperty
}

val prepareDirectory by
    tasks.registering(DirectoryAssets::class) {
        contractDirectory.set(layout.buildDirectory.dir("generated/searchContractAssets"))
        outputs.upToDateWhen { false }
        workingDir(rootProject.projectDir.parentFile)
        commandLine(
            "cargo",
            "run",
            "--locked",
            "--manifest-path",
            "tools/android-check/Cargo.toml",
            "--",
            "bundle",
        )
    }

tasks.named("preBuild") { dependsOn(prepareDirectory) }

androidComponents.onVariants { variant ->
    variant.androidTest?.sources?.assets?.addGeneratedSourceDirectory(prepareDirectory) {
        it.contractDirectory
    }
}

dependencies {
    implementation(project(":data"))
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("androidx.work:work-runtime-ktx:2.12.0")
    implementation("androidx.core:core-splashscreen:1.2.0")
    implementation("androidx.navigation3:navigation3-runtime:1.2.1")
    implementation("androidx.navigation3:navigation3-ui:1.2.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
    testImplementation("org.robolectric:robolectric:4.17")
    androidTestImplementation(platform("androidx.compose:compose-bom:2026.09.00"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
