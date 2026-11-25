// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.

package io.github.romanaerl.open3dpc

import java.nio.ByteBuffer

/** A rectangle in frame pixels, before any display rotation. */
data class FrameRect(val left: Float, val top: Float, val right: Float, val bottom: Float)

internal data class ScanPoint(val x: Float, val y: Float)
internal fun interface QuadProposalGenerator { fun proposals(frame: Open3DPCFrame, roi: FrameRect): List<List<ScanPoint>> }

/**
 * One image: full-range 8-bit luma, top row first, and optionally chroma.
 *
 * [chroma], when present, is interleaved U, V at half size with [width] bytes a row. Without it the
 * reader cannot tell apart materials that differ in hue but not in brightness.
 */
class Open3DPCFrame(
    val luma: ByteArray, val width: Int, val height: Int, val rowStride: Int = width, val chroma: ByteArray? = null,
) {
    init {
        require(width > 0 && height > 0 && rowStride >= width && luma.size >= rowStride * (height - 1) + width)
        require(chroma == null || (width % 2 == 0 && height % 2 == 0 && chroma.size >= width * (height / 2)))
    }

    val bounds get() = FrameRect(0f, 0f, width.toFloat(), height.toFloat())

    companion object {
        /**
         * Copies the planes of an Android `YUV_420_888` image (`ImageProxy.planes`), with the strides the
         * device reports, so that the image can be closed at once. Width and height must be even.
         */
        fun fromYuv420(
            width: Int, height: Int, y: ByteBuffer, yRowStride: Int,
            u: ByteBuffer, v: ByteBuffer, uvRowStride: Int, uvPixelStride: Int,
        ): Open3DPCFrame {
            val luma = ByteArray(width * height)
            val chroma = ByteArray(width * (height / 2))
            val source = y.duplicate()
            for (row in 0 until height) {
                source.position(row * yRowStride)
                source.get(luma, row * width, width)
            }
            for (row in 0 until height / 2) for (column in 0 until width / 2) {
                val at = row * uvRowStride + column * uvPixelStride
                chroma[row * width + column * 2] = u.get(at)
                chroma[row * width + column * 2 + 1] = v.get(at)
            }
            return Open3DPCFrame(luma, width, height, width, chroma)
        }
    }
}
