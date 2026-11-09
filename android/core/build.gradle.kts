plugins {
    kotlin("jvm")
    id("com.ncorti.ktfmt.gradle")
    id("dev.detekt")
    id("info.solidsoft.pitest")
}

ktfmt { kotlinLangStyle() }

detekt {
    buildUponDefaultConfig.set(true)
    config.setFrom(rootProject.file("detekt.yml"))
}

kotlin {
    jvmToolchain(21)
    compilerOptions { allWarningsAsErrors.set(true) }
}

val variants =
    tasks.register<Copy>("copyKanjiVariants") {
        from("../../src/core/kanji-variants.ts")
        into(layout.buildDirectory.dir("generated/resources"))
        rename { "kanji-variants.txt" }
    }

val readings =
    tasks.register<Copy>("copyPlaceReadings") {
        from("../../ios/Sources/PhonebookKit/PlaceReadings.json")
        into(layout.buildDirectory.dir("generated/readings"))
    }

sourceSets {
    main {
        resources.srcDir(variants)
        resources.srcDir(readings)
    }
    test {
        resources.srcDir("../../ios/Tests/PhonebookCoreTests")
        resources.srcDir("../../ios/Tests/PhonebookKitTests")
        resources.include("SearchContract.json", "PlaceReadingContract.json")
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
}

tasks.test { testLogging { events("failed", "passed", "skipped") } }

pitest {
    pitestVersion.set("1.30.1")
    targetClasses.set(
        setOf(
            "page.dial.core.CallerPolicy",
            "page.dial.core.TransferPolicy",
            "page.dial.core.PublicationPolicy",
            "page.dial.core.PagePolicy",
            "page.dial.core.JsonPolicy",
            "page.dial.core.WordPolicy",
        )
    )
    targetTests.set(setOf("page.dial.core.*Test"))
    threads.set(1)
    outputFormats.set(setOf("XML", "HTML"))
    timestampedReports.set(false)
    failWhenNoMutations.set(true)
    mutationThreshold.set(100)
    timeoutConstInMillis.set(10000)
    jvmArgs.set(listOf("-Xmx512m", "-XX:ActiveProcessorCount=2"))
    mainProcessJvmArgs.set(listOf("-Xmx512m", "-XX:ActiveProcessorCount=2"))
}
