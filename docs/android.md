# Reading Open3DPC on Android and the JVM

The Kotlin library has no dependencies beyond the Kotlin standard library: no OpenCV, no ML Kit, no
Android classes. It is compiled to Java 11 bytecode and works on Android and on a server.

## 1. Add the library

It is not published to a Maven repository yet. Either build it:

```bash
cd kotlin && ./gradlew :open3dpc:jar      # kotlin/open3dpc/build/libs/
```

and add the jar to your app, or include the build in your `settings.gradle.kts`:

```kotlin
includeBuild("path/to/open3dpc/kotlin")
// in the app module
dependencies { implementation("io.github.romanaerl:open3dpc:0.1.0-SNAPSHOT") }
```

`fromYuv420`, the reader and the rest use no Java API newer than 11; the app module needs
`compileOptions` of 11 or higher.

## 2. Show the scanner

With CameraX (`camera-camera2`, `camera-lifecycle`, `camera-view`) and the CAMERA permission, copy
[examples/android/Open3DPCCamera.kt](../examples/android/Open3DPCCamera.kt):

```kotlin
val camera = Open3DPCCamera(this, this, previewView, { viewfinderInPreview }) { code ->
    Log.d("Open3DPC", "${code.bits} ${code.value}")   // 10011100001111 9999
}
camera.start()
```

## 3. Or put the reader into a camera you already have

```kotlin
val reader = Open3DPCReader(payloadLengths = setOf(14), geometries = setOf(Open3DPCGeometry(4, 6)))
val stabilizer = Open3DPCStabilizer()

fun analyze(image: ImageProxy) {
    val frame = image.use {
        val (y, u, v) = it.planes
        Open3DPCFrame.fromYuv420(it.width, it.height, y.buffer, y.rowStride, u.buffer, v.buffer, u.rowStride, u.pixelStride)
    }
    val code = stabilizer.observe(reader.read(frame, roi), SystemClock.elapsedRealtime())
    if (code != null) { /* confirmed: seen in two frames, alone in the viewfinder */ }
}
```

What has to be right:

| Setting | Why |
|---|---|
| `OUTPUT_IMAGE_FORMAT_YUV_420_888` | The reader takes luma, and chroma for pairs that differ in hue |
| `STRATEGY_KEEP_ONLY_LATEST` and one analysis thread | A read can take longer than a frame interval; the reader keeps its buffers |
| Preview and analysis at one aspect ratio | One transform then maps the viewfinder to the buffer |
| `roi` = the viewfinder, in buffer pixels | Less work, and no reading of a neighbouring code |
| A copy before `image.close()` | `fromYuv420` copies, so the image can be closed at once and ML Kit can run beside it |
| `LowLightTorchPolicy` | In the dark there is no contrast |

`payloadLengths` and `geometries` decide what this session reads: the lengths in bits and the shapes,
`Open3DPCGeometry(rows, columns)`. Both default to any; set them to the codes you print
([why](../README.md#you-decide-what-a-session-reads)).

`roi` and `corners` are in **buffer** pixels, origin top left, before any display rotation. The example
maps the viewfinder through `PreviewView.getSensorToViewTransform()` and
`ImageInfo.getSensorToBufferTransformMatrix()`. Do not rotate the frame: the code carries its own
orientation.

For the torch, read `LENS_APERTURE`, `SENSOR_EXPOSURE_TIME` (nanoseconds) and `SENSOR_SENSITIVITY` from
`TotalCaptureResult` with `Camera2Interop`, turn them into a brightness with
`LowLightTorchPolicy.brightness`, and call `cameraControl.enableTorch(true)` when `shouldLight` says so.

## 4. Photos and servers

Give the reader any 8-bit greyscale image:

```kotlin
val codes = Open3DPCReader().read(Open3DPCFrame(luma, width, height))
```

## What to expect

A single frame may be refused even when the code is plain to see; a moving hand gives the reader the
next one. Some payloads are refused much more often: see
[Known limits of the readers](reader-pipeline.md#known-limits-of-the-readers). Distance, time to read
and success rate on real prints have not been measured.
