plugins {
    kotlin("jvm") version "2.2.21"
    `java-library`
}

group = "io.github.romanaerl"
version = "0.1.0-SNAPSHOT"

// Java 11 bytecode, no dependencies but the Kotlin standard library: usable from Android and the JVM.
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_11) } }
java {
    sourceCompatibility = JavaVersion.VERSION_11
    targetCompatibility = JavaVersion.VERSION_11
    withSourcesJar()
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
}

tasks.test {
    val specification = rootProject.file("../spec")
    inputs.dir(specification)
    systemProperty("open3dpc.spec", specification.path)
    testLogging { events("passed", "failed"); showStandardStreams = true }
}
