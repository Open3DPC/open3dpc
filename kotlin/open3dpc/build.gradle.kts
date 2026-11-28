import com.vanniktech.maven.publish.JavadocJar
import com.vanniktech.maven.publish.KotlinJvm

plugins {
    kotlin("jvm") version "2.2.21"
    `java-library`
    id("com.vanniktech.maven.publish") version "0.34.0"
}

// One version for the whole project: the npm packages, the Swift tag and this library all read the root
// package.json, and the release workflows refuse a tag that differs from it.
val projectVersion: String = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"")
    .find(rootProject.file("../package.json").readText())!!.groupValues[1]

group = "org.open3dpc"
version = projectVersion

// Java 11 bytecode, no dependencies but the Kotlin standard library: usable from Android and the JVM.
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_11) } }
java {
    sourceCompatibility = JavaVersion.VERSION_11
    targetCompatibility = JavaVersion.VERSION_11
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

// Maven Central through the Central Portal. A deployment is uploaded and validated, then waits on
// central.sonatype.com until the maintainer presses Publish: like npm's staged publishing, nothing goes
// out without his hand. Credentials and the signing key come from the release workflow's secrets.
mavenPublishing {
    configure(KotlinJvm(javadocJar = JavadocJar.Empty(), sourcesJar = true))
    publishToMavenCentral()
    signAllPublications()
    coordinates("org.open3dpc", "open3dpc", projectVersion)
    pom {
        name.set("Open3DPC")
        description.set("Read Open3DPC codes — a tiny two-color code made for 3D printing — from camera frames and photos. No dependencies but the Kotlin standard library.")
        url.set("https://open3dpc.org")
        inceptionYear.set("2026")
        licenses {
            license {
                name.set("The Apache License, Version 2.0")
                url.set("https://www.apache.org/licenses/LICENSE-2.0.txt")
                distribution.set("repo")
            }
        }
        developers {
            developer {
                id.set("romanaerl")
                name.set("Roman Simonov")
                url.set("https://github.com/romanaerl")
            }
        }
        scm {
            url.set("https://github.com/Open3DPC/open3dpc")
            connection.set("scm:git:https://github.com/Open3DPC/open3dpc.git")
            developerConnection.set("scm:git:ssh://git@github.com/Open3DPC/open3dpc.git")
        }
    }
}
