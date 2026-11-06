plugins {
    id("com.android.application") version "9.5.0" apply false
    id("com.android.library") version "9.5.0" apply false
    kotlin("jvm") version "2.4.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.21" apply false
    id("com.ncorti.ktfmt.gradle") version "0.27.0" apply false
    id("dev.detekt") version "2.0.0-alpha.6" apply false
    id("org.cyclonedx.bom") version "3.5.1" apply false
    id("info.solidsoft.pitest") version "1.19.0" apply false
}
allprojects {
    dependencyLocking { lockAllConfigurations() }
    tasks.withType<Test>().configureEach {
        maxParallelForks = 1
        maxHeapSize = "512m"
        jvmArgs("-XX:ActiveProcessorCount=2")
        timeout.set(java.time.Duration.ofMinutes(2))
    }
}
