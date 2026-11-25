// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.

package io.github.romanaerl.open3dpc

import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.min

/** A point in the camera buffer: origin top-left, x right, y down, before any display rotation. */
data class FramePoint(val x: Double, val y: Double)

/**
 * The four-point DLT, row-major with `m[8]` normalised to 1. Corners
 * go top-left, top-right, bottom-right, bottom-left in both quadrilaterals.
 */
internal class Homography(private val m: DoubleArray) {
    fun applyX(x: Double, y: Double) = (m[0] * x + m[1] * y + m[2]) / (m[6] * x + m[7] * y + m[8])
    fun applyY(x: Double, y: Double) = (m[3] * x + m[4] * y + m[5]) / (m[6] * x + m[7] * y + m[8])

    companion object {
        fun mapping(source: List<FramePoint>, destination: List<FramePoint>): Homography? {
            if (source.size != 4 || destination.size != 4) return null
            val a = Array(8) { DoubleArray(9) }
            for (index in 0 until 4) {
                val (x, y) = source[index]
                val (u, v) = destination[index]
                a[index * 2] = doubleArrayOf(x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y, u)
                a[index * 2 + 1] = doubleArrayOf(0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y, v)
            }
            for (column in 0 until 8) {
                var pivot = column
                for (row in column until 8) if (abs(a[row][column]) > abs(a[pivot][column])) pivot = row
                if (abs(a[pivot][column]) <= 1e-12) return null
                val swap = a[column]; a[column] = a[pivot]; a[pivot] = swap
                val divisor = a[column][column]
                for (index in column..8) a[column][index] /= divisor
                for (row in 0 until 8) {
                    if (row == column) continue
                    val factor = a[row][column]
                    if (factor == 0.0) continue
                    for (index in column..8) a[row][index] -= factor * a[column][index]
                }
            }
            return Homography(DoubleArray(9) { if (it < 8) a[it][8] else 1.0 })
        }
    }
}

internal object Perspective {
    /** How far outside the contour rectification is aimed: the middle of the asymmetric budget. */
    const val REGISTRATION_MARGIN = 0.08

    /** `expanded`: every edge offset along its own outward normal, the corners re-intersected. */
    fun expanded(quad: List<FramePoint>, fraction: Double = REGISTRATION_MARGIN): List<FramePoint> {
        if (quad.size != 4) return quad
        val sides = List(4) { distance(quad[it], quad[(it + 1) % 4]) }
        val shortest = sides.min()
        if (shortest <= 1) return quad
        val margin = shortest * fraction
        val centreX = quad.sumOf { it.x } / 4
        val centreY = quad.sumOf { it.y } / 4
        val originX = DoubleArray(4)
        val originY = DoubleArray(4)
        val directionX = DoubleArray(4)
        val directionY = DoubleArray(4)
        for (index in 0 until 4) {
            val start = quad[index]
            val end = quad[(index + 1) % 4]
            val dx = end.x - start.x
            val dy = end.y - start.y
            val scale = if (sides[index] > 0) sides[index] else 1.0
            var normalX = -dy / scale
            var normalY = dx / scale
            if (((start.x + end.x) / 2 - centreX) * normalX + ((start.y + end.y) / 2 - centreY) * normalY < 0) { normalX = -normalX; normalY = -normalY }
            originX[index] = start.x + normalX * margin
            originY[index] = start.y + normalY * margin
            directionX[index] = dx
            directionY[index] = dy
        }
        return List(4) { index ->
            val incoming = (index + 3) % 4
            val denominator = directionX[incoming] * directionY[index] - directionY[incoming] * directionX[index]
            if (abs(denominator) <= 1e-6) quad[index] else {
                val deltaX = originX[index] - originX[incoming]
                val deltaY = originY[index] - originY[incoming]
                val travel = (deltaX * directionY[index] - deltaY * directionX[index]) / denominator
                FramePoint(originX[incoming] + directionX[incoming] * travel, originY[incoming] + directionY[incoming] * travel)
            }
        }
    }

    fun distance(a: FramePoint, b: FramePoint) = hypot(a.x - b.x, a.y - b.y)

    /** Output size of a rectification: the opposite edges averaged. */
    fun rectifiedSize(quad: List<FramePoint>): Pair<Int, Int> = swiftRound((distance(quad[0], quad[1]) + distance(quad[3], quad[2])) / 2).toInt() to
        swiftRound((distance(quad[0], quad[3]) + distance(quad[1], quad[2])) / 2).toInt()
}

/** Bilinear sample of one plane with its own stride; the caller keeps the point inside the plane. */
internal fun bilinear(plane: ByteArray, rowStride: Int, pixelStride: Int, width: Int, height: Int, x: Double, y: Double, offset: Int = 0): Double {
    val clampedX = if (x < 0) 0.0 else if (x > width - 1.0) width - 1.0 else x
    val clampedY = if (y < 0) 0.0 else if (y > height - 1.0) height - 1.0 else y
    val x0 = clampedX.toInt()
    val y0 = clampedY.toInt()
    val x1 = min(x0 + 1, width - 1)
    val y1 = min(y0 + 1, height - 1)
    val fx = clampedX - x0
    val fy = clampedY - y0
    val row0 = offset + y0 * rowStride
    val row1 = offset + y1 * rowStride
    val p00 = plane[row0 + x0 * pixelStride].toInt() and 255
    val p10 = plane[row0 + x1 * pixelStride].toInt() and 255
    val p01 = plane[row1 + x0 * pixelStride].toInt() and 255
    val p11 = plane[row1 + x1 * pixelStride].toInt() and 255
    val top = p00 + (p10 - p00) * fx
    val bottom = p01 + (p11 - p01) * fx
    return top + (bottom - top) * fy
}
