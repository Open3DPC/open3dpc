// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.

package org.open3dpc

import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/** A pair of printed materials, RGB; `Filament` is a white-on-pink pair. */
internal class MaterialPair(val material: IntArray, val background: IntArray) {
    companion object {
        val DarkOnLight = MaterialPair(intArrayOf(0, 0, 0), intArrayOf(255, 255, 255))
        val LightOnDark = MaterialPair(intArrayOf(255, 255, 255), intArrayOf(0, 0, 0))
        val Filament = MaterialPair(intArrayOf(227, 209, 231), intArrayOf(233, 167, 203))
    }
}

internal data class TestCode(val payload: String, val matrix: List<String>)

/** Forty nine-bit codes on 3 × 5. */
internal fun testCodes(): List<TestCode> = (0..7).flatMap { high ->
    (0..4).map { low ->
        val payload = ((2 shl 6) or (high shl 3) or low).toString(2).padStart(9, '0')
        TestCode(payload, Open3DPC.encode(payload, 3, 5))
    }
}

internal data class PlanePose(val yaw: Double = 0.0, val pitch: Double = 0.0, val roll: Double = 0.0)

/** The normative construction of v2 §3.1–3.2 and its degradations. */
internal class ReferenceRaster(val rgba: ByteArray, val width: Int, val height: Int) {
    fun toRaster() = Raster(rgba, width, height, width * 4)

    fun rotatedClockwise(): ReferenceRaster {
        val output = ByteArray(rgba.size)
        val newWidth = height
        val newHeight = width
        for (y in 0 until height) for (x in 0 until width) {
            val source = (y * width + x) * 4
            val destination = (x * newWidth + newWidth - 1 - y) * 4
            for (channel in 0 until 4) output[destination + channel] = rgba[source + channel]
        }
        return ReferenceRaster(output, newWidth, newHeight)
    }

    private fun pixel(x: Double, y: Double, output: ByteArray, offset: Int) {
        if (x < -0.5 || y < -0.5 || x > width - 0.5 || y > height - 0.5) return
        for (channel in 0 until 3) output[offset + channel] = swiftRound(bilinear(rgba, width * 4, 4, width, height, x, y, channel)).toInt().coerceIn(0, 255).toByte()
    }

    fun blurred(sigma: Double): ReferenceRaster {
        if (sigma <= 0) return this
        val radius = max(1, swiftRound(sigma * 3).toInt())
        val kernel = DoubleArray(radius * 2 + 1) { val d = (it - radius).toDouble(); exp(-(d * d) / (2 * sigma * sigma)) }
        val weight = kernel.sum()
        for (index in kernel.indices) kernel[index] /= weight
        val horizontal = rgba.copyOf()
        val output = rgba.copyOf()
        for (y in 0 until height) for (x in 0 until width) for (channel in 0 until 3) {
            var total = 0.0
            for (index in kernel.indices) total += (rgba[(y * width + (x + index - radius).coerceIn(0, width - 1)) * 4 + channel].toInt() and 255) * kernel[index]
            horizontal[(y * width + x) * 4 + channel] = swiftRound(total).toInt().coerceIn(0, 255).toByte()
        }
        for (y in 0 until height) for (x in 0 until width) for (channel in 0 until 3) {
            var total = 0.0
            for (index in kernel.indices) total += (horizontal[((y + index - radius).coerceIn(0, height - 1) * width + x) * 4 + channel].toInt() and 255) * kernel[index]
            output[(y * width + x) * 4 + channel] = swiftRound(total).toInt().coerceIn(0, 255).toByte()
        }
        return ReferenceRaster(output, width, height)
    }

    /** A pinhole projection onto a larger canvas of the code's own background, with the true quad. */
    fun projected(pose: PlanePose, margin: Double = 0.35, canvas: Byte = -1): Pair<ReferenceRaster, List<FramePoint>> {
        val canvasWidth = swiftRound(width * (1 + margin * 2)).toInt()
        val canvasHeight = swiftRound(height * (1 + margin * 2)).toInt()
        val quad = projectedQuad(width.toDouble(), height.toDouble(), pose, canvasWidth.toDouble(), canvasHeight.toDouble())
        val corners = listOf(FramePoint(0.0, 0.0), FramePoint(width - 1.0, 0.0), FramePoint(width - 1.0, height - 1.0), FramePoint(0.0, height - 1.0))
        val map = Homography.mapping(quad, corners) ?: return this to quad
        val output = ByteArray(canvasWidth * canvasHeight * 4) { if (it % 4 == 3) -1 else canvas }
        for (y in 0 until canvasHeight) for (x in 0 until canvasWidth)
            pixel(map.applyX(x.toDouble(), y.toDouble()), map.applyY(x.toDouble(), y.toDouble()), output, (y * canvasWidth + x) * 4)
        return ReferenceRaster(output, canvasWidth, canvasHeight) to quad
    }

    /** Rectification: opposite edges averaged for the size. */
    fun rectified(quad: List<FramePoint>): ReferenceRaster? {
        val (outputWidth, outputHeight) = Perspective.rectifiedSize(quad)
        if (outputWidth < 8 || outputHeight < 8) return null
        val destination = listOf(FramePoint(0.0, 0.0), FramePoint(outputWidth - 1.0, 0.0), FramePoint(outputWidth - 1.0, outputHeight - 1.0), FramePoint(0.0, outputHeight - 1.0))
        val map = Homography.mapping(destination, quad) ?: return null
        val output = ByteArray(outputWidth * outputHeight * 4) { -1 }
        for (y in 0 until outputHeight) for (x in 0 until outputWidth)
            pixel(map.applyX(x.toDouble(), y.toDouble()), map.applyY(x.toDouble(), y.toDouble()), output, (y * outputWidth + x) * 4)
        return ReferenceRaster(output, outputWidth, outputHeight)
    }

    companion object {
        /** Cell [r,c] is a solid M × M square at ((c+1)M, (r+1)M); the frame and bands are exactly M/2. */
        fun render(matrix: List<String>, module: Int, shrunken: Boolean = false, pair: MaterialPair = MaterialPair.DarkOnLight): ReferenceRaster {
            require(module % 2 == 0)
            val rows = matrix.size
            val columns = matrix[0].length
            val width = (columns + 2) * module
            val height = (rows + 2) * module
            val data = ByteArray(width * height * 4)
            for (index in 0 until width * height) {
                for (channel in 0 until 3) data[index * 4 + channel] = pair.background[channel].toByte()
                data[index * 4 + 3] = -1
            }
            fun fill(startX: Int, startY: Int, endX: Int, endY: Int) {
                for (y in max(0, startY) until min(height, endY)) for (x in max(0, startX) until min(width, endX))
                    for (channel in 0 until 3) data[(y * width + x) * 4 + channel] = pair.material[channel].toByte()
            }
            val frame = module / 2
            fill(0, 0, width, frame); fill(0, height - frame, width, height); fill(0, 0, frame, height); fill(width - frame, 0, width, height)
            for (row in 0 until rows) for (column in 0 until columns) {
                val cell = matrix[row][column]
                if (cell == 'O') { fill(frame, frame, frame + module, frame + module); continue }
                if (cell != '1') continue
                if (!shrunken) fill((column + 1) * module, (row + 1) * module, (column + 2) * module, (row + 2) * module) else {
                    val centerX = ((column + 1.5) * module).toInt()
                    val centerY = ((row + 1.5) * module).toInt()
                    val half = (module * 0.35).toInt()
                    fill(centerX - half, centerY - half, centerX + half, centerY + half)
                }
            }
            return ReferenceRaster(data, width, height)
        }

        fun projectedQuad(width: Double, height: Double, pose: PlanePose, canvasWidth: Double, canvasHeight: Double): List<FramePoint> {
            val yaw = Math.toRadians(pose.yaw)
            val pitch = Math.toRadians(pose.pitch)
            val roll = Math.toRadians(pose.roll)
            val distance = max(width, height) * 2.4
            return listOf(-width / 2 to -height / 2, width / 2 to -height / 2, width / 2 to height / 2, -width / 2 to height / 2).map { (cornerX, cornerY) ->
                var x = cornerX * cos(roll) - cornerY * sin(roll)
                var y = cornerX * sin(roll) + cornerY * cos(roll)
                var z = -x * sin(yaw)
                x *= cos(yaw)
                val nextY = y * cos(pitch) - z * sin(pitch)
                z = y * sin(pitch) + z * cos(pitch)
                y = nextY
                z += distance
                FramePoint(distance * x / z + canvasWidth / 2, distance * y / z + canvasHeight / 2)
            }
        }

        fun dilated(quad: List<FramePoint>, modules: Double, module: Double): List<FramePoint> {
            if (modules == 0.0) return quad
            val centreX = quad.sumOf { it.x } / 4
            val centreY = quad.sumOf { it.y } / 4
            return quad.map { corner ->
                val deltaX = corner.x - centreX
                val deltaY = corner.y - centreY
                val length = hypot(deltaX, deltaY)
                if (length <= 1e-9) corner else FramePoint(corner.x + deltaX * modules * module / length, corner.y + deltaY * modules * module / length)
            }
        }

        fun jittered(quad: List<FramePoint>, modules: Double, module: Double, seed: Int): List<FramePoint> {
            val magnitude = modules * module
            if (magnitude <= 0) return quad
            var state = (seed.toLong() * 0x9E37_79B9L + 0x85EB_CA6BL).toULong()
            fun nextAngle(): Double {
                state = state * 6_364_136_223_846_793_005uL + 1_442_695_040_888_963_407uL
                return ((state shr 33) % 3_600uL).toDouble() / 3_600 * 2 * Math.PI
            }
            return quad.map { corner ->
                val angle = nextAngle()
                FramePoint(corner.x + cos(angle) * magnitude, corner.y + sin(angle) * magnitude)
            }
        }
    }
}
