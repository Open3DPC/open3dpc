// A minimal Open3DPC scanner on CameraX. Copy it into an app that depends on the Kotlin library.
// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.

package com.example.open3dpc

import android.content.Context
import android.graphics.Matrix
import android.graphics.RectF
import android.os.SystemClock
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import io.github.romanaerl.open3dpc.FrameRect
import io.github.romanaerl.open3dpc.Open3DPCFrame
import io.github.romanaerl.open3dpc.Open3DPCReader
import io.github.romanaerl.open3dpc.Open3DPCReading
import io.github.romanaerl.open3dpc.Open3DPCStabilizer
import java.util.concurrent.Executors

/**
 * Shows the camera in [view] and calls [onCode] on the main thread, once per confirmed code. The app
 * holds the CAMERA permission before [start].
 */
class Open3DPCCamera(
    private val context: Context,
    private val owner: LifecycleOwner,
    private val view: PreviewView,
    /** The viewfinder in [view] coordinates; codes outside it are not searched for. */
    private val viewfinder: () -> RectF,
    private val onCode: (Open3DPCReading) -> Unit,
) {
    private val main = ContextCompat.getMainExecutor(context)
    private val analysisThread = Executors.newSingleThreadExecutor()

    // Used on the analysis thread only.
    private val reader = Open3DPCReader(payloadLengths = setOf(14))
    private val stabilizer = Open3DPCStabilizer()
    private var delivered: String? = null

    /** Written on the main thread, where the preview transform may be read. */
    @Volatile private var roi: FrameRect? = null
    private var provider: ProcessCameraProvider? = null

    fun start() {
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({ bind(future.get()) }, main)
    }

    fun stop() {
        provider?.unbindAll()
        analysisThread.shutdown()
    }

    private fun bind(provider: ProcessCameraProvider) {
        this.provider = provider
        // Preview and analysis at one aspect ratio, so that one transform maps between them.
        val ratio = ResolutionSelector.Builder().setAspectRatioStrategy(AspectRatioStrategy.RATIO_16_9_FALLBACK_AUTO_STRATEGY).build()
        val preview = Preview.Builder().setResolutionSelector(ratio).build().also { it.surfaceProvider = view.surfaceProvider }
        val analysis = ImageAnalysis.Builder().setResolutionSelector(ratio)
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888).build()
        analysis.setAnalyzer(analysisThread, ::analyze)
        provider.unbindAll()
        provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
    }

    private fun analyze(image: ImageProxy) {
        val sensorToBuffer = Matrix(image.imageInfo.sensorToBufferTransformMatrix)
        val bounds = RectF(0f, 0f, image.width.toFloat(), image.height.toFloat())
        val frame = image.use {
            val (y, u, v) = it.planes
            Open3DPCFrame.fromYuv420(it.width, it.height, y.buffer, y.rowStride, u.buffer, v.buffer, u.rowStride, u.pixelStride)
        }
        main.execute { roi = viewfinderInBuffer(sensorToBuffer, bounds) }
        val region = roi ?: return

        val code = stabilizer.observe(reader.read(frame, region), SystemClock.elapsedRealtime())
        if (code == null) { delivered = null; return }
        if (delivered == code.bits) return
        delivered = code.bits
        main.execute { onCode(code) }
    }

    /** View to buffer, through the sensor space both are defined in; null until the preview has a transform. */
    private fun viewfinderInBuffer(sensorToBuffer: Matrix, bounds: RectF): FrameRect? {
        val viewToBuffer = Matrix()
        if (view.sensorToViewTransform?.invert(viewToBuffer) != true) return null
        viewToBuffer.postConcat(sensorToBuffer)
        val box = RectF(viewfinder())
        viewToBuffer.mapRect(box)
        return if (box.intersect(bounds)) FrameRect(box.left, box.top, box.right, box.bottom) else null
    }
}
