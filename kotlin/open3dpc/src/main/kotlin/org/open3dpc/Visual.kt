// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.

package org.open3dpc

import java.util.Locale
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/** The gate that rejected a candidate: classify by this, never by parsing a detail string. */
internal enum class Open3DPCRejection {
    None, RectifiedFrameTooSmall, FrameContrastBelowThreshold, PolarityRingNotMaterial, InteriorLacksOppositeMaterial,
    FrameThicknessInconsistent, ModulesNotSquare, NoUniqueAttachedMarker, AmbiguousCornerMarkers, MarkerQuietBandMissing,
    ModuleQuietBandMissing, NoProtocolValidGrid, MarkerDisagreesWithScale, OuterFrameDiscontinuous, AmbiguousCellConfidence,
    AmbiguousGeometry, CoarseProposalLacksOppositeMaterial, NoCornerStep, NoSecondPassRectangle, SecondPassLacksOppositeMaterial,
}

/** How far a candidate got; `ordinal` is the priority. The stages are in docs/reader-pipeline.md. */
internal enum class Open3DPCStage { Frame, Sampling, Geometry, AmbiguousCell, Malformed, Orientation, Crc, EmptyDataRegion, Validated }

/** Structural gates. A reader uses [Strict]; the rest exist for experiments. */
internal data class Open3DPCGates(
    val requireConsistentFrameThickness: Boolean = true,
    val requireSquareModules: Boolean = false,
    val requireOuterFrameContinuity: Boolean = true,
    val requireMarkerQuietBand: Boolean = true,
    val requireModuleQuietBands: Boolean = true,
    val requireUniqueCornerStep: Boolean = true,
) {
    companion object {
        val Strict = Open3DPCGates()
    }
}

/** The physical layer's verdict with its reason, which [Open3DPC.validate] folds into a null. */
internal sealed interface PhysicalVerdict {
    data class Valid(val payload: String, val height: Int, val width: Int, val crc: String) : PhysicalVerdict
    data object InvalidOrientation : PhysicalVerdict
    data object InvalidGeometry : PhysicalVerdict
    data object Malformed : PhysicalVerdict
    data object CrcMismatch : PhysicalVerdict
    data object EmptyDataRegion : PhysicalVerdict
}

/** [Open3DPC.validate] with a typed verdict; prefers the turn whose geometry §4 admits. */
internal fun validatePhysical(observed: List<String>): PhysicalVerdict {
    var rows = observed
    var first: List<String>? = null
    var normal: List<String>? = null
    for (turn in 0 until 4) {
        if (rows.sumOf { row -> row.count { it == 'O' } } != 1) return PhysicalVerdict.InvalidOrientation
        if (rows[0][0] == 'O') {
            if (Open3DPC.valid(rows.size, rows[0].length)) { normal = rows; break }
            if (first == null) first = rows
        }
        rows = Open3DPC.rotate(rows)
    }
    val matrix = normal ?: first ?: return PhysicalVerdict.InvalidOrientation
    val h = matrix.size
    val w = matrix[0].length
    if (!Open3DPC.valid(h, w)) return PhysicalVerdict.InvalidGeometry
    val width = min(h, 10)
    val data = StringBuilder()
    val crc = StringBuilder()
    for (r in 0 until h) for (c in 0 until w) {
        if (r == 0 && c == 0) continue
        if (c == w - 1 && r < width) crc.append(matrix[r][c]) else data.append(matrix[r][c])
    }
    if (Open3DPC.crc(data.toString(), h) != crc.toString()) return PhysicalVerdict.CrcMismatch
    val terminator = data.lastIndexOf("1")
    if (terminator < 0) return PhysicalVerdict.EmptyDataRegion
    return PhysicalVerdict.Valid(data.substring(0, terminator), h, w, crc.toString())
}

/** `Geometry.isValidInSomeOrientation`: CRC width derives from height, so validity depends on the turn. */
internal fun validInSomeOrientation(height: Int, width: Int) = Open3DPC.valid(height, width) || Open3DPC.valid(width, height)

/** To nearest, away from zero, as the Swift reader rounds: the two must agree bit for bit. */
internal fun swiftRound(value: Double) = if (value >= 0) floor(value + 0.5) else ceil(value - 0.5)

internal fun format1(value: Double) = String.format(Locale.ROOT, "%.1f", value)

/** Which projection of the pixel triple counts as "how much material is here". */
internal enum class MaterialAxis { Achromatic, Chromatic }

/** RGBA8, top-down: the perspective-corrected canvas, the only coordinate system the sampler knows. */
internal class Raster(val bytes: ByteArray, val width: Int, val height: Int, val bytesPerRow: Int, val axis: MaterialAxis = MaterialAxis.Achromatic) {
    fun on(axis: MaterialAxis) = Raster(bytes, width, height, bytesPerRow, axis)

    fun brightness(x: Double, y: Double, span: Double, minimumHalf: Int = 1): Double {
        val half = max(minimumHalf, (span / 2).toInt())
        val centerX = min(max(swiftRound(x).toInt(), 0), width - 1)
        val centerY = min(max(swiftRound(y).toInt(), 0), height - 1)
        val firstRow = max(0, centerY - half)
        val lastRow = min(height - 1, centerY + half)
        val firstColumn = max(0, centerX - half)
        val lastColumn = min(width - 1, centerX + half)
        if (axis == MaterialAxis.Achromatic) {
            var total = 0
            var samples = 0
            for (row in firstRow..lastRow) {
                var index = row * bytesPerRow + firstColumn * 4
                for (column in firstColumn..lastColumn) {
                    total += (bytes[index].toInt() and 255) + (bytes[index + 1].toInt() and 255) + (bytes[index + 2].toInt() and 255)
                    samples += 3
                    index += 4
                }
            }
            return if (samples > 0) total.toDouble() / samples else 0.0
        }
        var total = 0.0
        var samples = 0
        for (row in firstRow..lastRow) {
            var index = row * bytesPerRow + firstColumn * 4
            for (column in firstColumn..lastColumn) {
                val red = (bytes[index].toInt() and 255).toDouble()
                val green = (bytes[index + 1].toInt() and 255).toDouble()
                val blue = (bytes[index + 2].toInt() and 255).toDouble()
                total += CHROMATIC_BASE + CHROMATIC_GAIN * (green - (red + blue) / 2)
                samples++
                index += 4
            }
        }
        return if (samples > 0) total / samples else 0.0
    }

    /** `rect.integral` clipped to the raster; the crop inherits the projection. */
    fun cropped(left: Double, top: Double, right: Double, bottom: Double): Raster? {
        val x = max(floor(left), 0.0).toInt()
        val y = max(floor(top), 0.0).toInt()
        val cropWidth = min(ceil(right), width.toDouble()).toInt() - x
        val cropHeight = min(ceil(bottom), height.toDouble()).toInt() - y
        if (cropWidth < 8 || cropHeight < 8) return null
        val rowWidth = cropWidth * 4
        val output = ByteArray(rowWidth * cropHeight)
        for (row in 0 until cropHeight) System.arraycopy(bytes, (y + row) * bytesPerRow + x * 4, output, row * rowWidth, rowWidth)
        return Raster(output, cropWidth, cropHeight, rowWidth, axis)
    }

    private companion object {
        const val CHROMATIC_BASE = 128.0
        const val CHROMATIC_GAIN = 3.0
    }
}

/**
 * `ThresholdField`: the material/background threshold as a plane, so it can follow illumination and
 * cannot bend sharply enough to follow the code.
 */
internal class ThresholdField(image: Raster, span: Double) {
    val minimum: Double
    val maximum: Double
    private val width = image.width.toDouble()
    private val height = image.height.toDouble()
    private var base = 0.0
    private var perX = 0.0
    private var perY = 0.0
    val contrast get() = maximum - minimum
    val isGraded get() = perX != 0.0 || perY != 0.0

    init {
        val steps = 12
        val xs = DoubleArray(steps * steps)
        val ys = DoubleArray(steps * steps)
        val values = DoubleArray(steps * steps)
        var index = 0
        for (row in 1..steps) for (column in 1..steps) {
            val x = column.toDouble() / (steps + 1)
            val y = row.toDouble() / (steps + 1)
            xs[index] = x; ys[index] = y
            values[index++] = image.brightness(width * x, height * y, span)
        }
        minimum = values.min()
        maximum = values.max()
        val flat = (minimum + maximum) / 2
        val globalContrast = maximum - minimum
        base = flat

        val tiles = 4
        val pointX = ArrayList<Double>()
        val pointY = ArrayList<Double>()
        val pointT = ArrayList<Double>()
        for (tileRow in 0 until tiles) for (tileColumn in 0 until tiles) {
            var low = Double.POSITIVE_INFINITY
            var high = Double.NEGATIVE_INFINITY
            var any = false
            for (i in values.indices) if ((xs[i] * tiles).toInt() == tileColumn && (ys[i] * tiles).toInt() == tileRow) {
                any = true; low = min(low, values[i]); high = max(high, values[i])
            }
            if (!any || high - low < globalContrast * 0.5) continue
            pointX += (tileColumn + 0.5) / tiles
            pointY += (tileRow + 0.5) / tiles
            pointT += (low + high) / 2
        }
        if (pointT.size >= 4) fit(pointX, pointY, pointT, globalContrast)
    }

    private fun fit(xs: List<Double>, ys: List<Double>, ts: List<Double>, globalContrast: Double) {
        val n = ts.size.toDouble()
        val sumX = xs.sum()
        val sumY = ys.sum()
        val sumXX = xs.sumOf { it * it }
        val sumYY = ys.sumOf { it * it }
        val sumXY = xs.indices.sumOf { xs[it] * ys[it] }
        val sumT = ts.sum()
        val sumXT = xs.indices.sumOf { xs[it] * ts[it] }
        val sumYT = ys.indices.sumOf { ys[it] * ts[it] }
        val determinant = n * (sumXX * sumYY - sumXY * sumXY) - sumX * (sumX * sumYY - sumXY * sumY) + sumY * (sumX * sumXY - sumXX * sumY)
        if (abs(determinant) <= 1e-9) return
        fun solve(column: Int): Double {
            val m = arrayOf(doubleArrayOf(n, sumX, sumY), doubleArrayOf(sumX, sumXX, sumXY), doubleArrayOf(sumY, sumXY, sumYY))
            m[0][column] = sumT; m[1][column] = sumXT; m[2][column] = sumYT
            val value = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
                m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
                m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
            return value / determinant
        }
        val fittedBase = solve(0)
        val fittedPerX = solve(1)
        val fittedPerY = solve(2)
        if (abs(fittedPerX) + abs(fittedPerY) < globalContrast * 0.25) return
        base = fittedBase; perX = fittedPerX; perY = fittedPerY
    }

    operator fun invoke(x: Double, y: Double): Double {
        if (!isGraded) return base
        val value = base + perX * (x / width) + perY * (y / height)
        return min(max(value, minimum + contrast * 0.2), maximum - contrast * 0.2)
    }
}
